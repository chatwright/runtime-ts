/**
 * An {@link "../provider.js".Provider} that speaks the OpenAI-compatible
 * chat-completions wire format (`POST {baseURL}/chat/completions`) — the same
 * shape Ollama, LM Studio, OpenRouter, vLLM and OpenAI itself expose. Ported
 * from the Go runtime's `actor/openai/provider.go`.
 *
 * @remarks
 * Providers are dumb transports: this one renders a
 * {@link "../provider.js".Prompt} to a system+user message pair, asks for
 * exactly one JSON object via `response_format` (structured output where the
 * server supports it, with a graceful one-shot json_object fallback
 * otherwise), and maps the reply to a {@link "../provider.js".Proposal}. It
 * never fabricates a proposal: an unparseable or malformed reply is a typed
 * {@link InvalidResponseError}.
 *
 * The HTTP client is an injected `fetch` so `propose` never touches the
 * network in tests. `Usage.cost` is always left absent: this package fronts
 * arbitrary local/self-hosted servers with no shared pricing source.
 */

import type { Prompt, ProposeResult, Provider, Usage } from "../provider.js";
import {
  jsonObjectFallbackInstructions,
  jsonObjectResponseFormat,
  jsonSchemaResponseFormat,
  renderPrompt,
} from "./prompt.js";
import { proposalFromResponse } from "./response.js";
import { FallbackFailedError } from "./errors.js";
import { classifyStatusError, retryable, truncateBody, type ChatCompletionResponse } from "./wire.js";

/**
 * The default {@link Config.maxTokens}: generous headroom for a short
 * rationale plus the fixed JSON scaffolding. Raised from 1024 to 2048 after
 * the first actor-model arena run observed `finish_reason=length` truncating
 * replies mid-JSON at 1024.
 */
export const DefaultMaxTokens = 2048;

/** Thrown by {@link OpenAIProvider}'s constructor when `baseURL` is empty. */
export class MissingBaseURLError extends Error {
  constructor() {
    super("actor/openai: no base URL: set Config.baseURL (e.g. http://localhost:11434/v1 for Ollama)");
    this.name = "MissingBaseURLError";
  }
}

/** Thrown by {@link OpenAIProvider}'s constructor when `model` is empty. */
export class MissingModelError extends Error {
  constructor() {
    super("actor/openai: no model: set Config.model");
    this.name = "MissingModelError";
  }
}

/**
 * Names which `response_format` mode served a `propose` call. A string-literal
 * union (never an integer enum) per this module's JSON-artefact convention.
 */
export type ResponseFormatMode = "json_schema" | "json_object_fallback";

/**
 * The minimal `fetch` surface {@link OpenAIProvider} needs — assignable from
 * the global `fetch`, and trivial to fake in tests.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Configures an {@link OpenAIProvider}. */
export interface Config {
  /** The OpenAI-compatible server's base URL, e.g. `http://localhost:11434/v1`. Required. A trailing slash is tolerated. */
  readonly baseURL: string;
  /** The model id the server should use, e.g. `qwen3.6:latest`. Required. */
  readonly model: string;
  /** Authenticates via `Authorization: Bearer <apiKey>`. Optional: when empty/absent, no Authorization header is sent at all. */
  readonly apiKey?: string;
  /** Bounds the model's reply (`max_tokens`). `<= 0`/absent uses {@link DefaultMaxTokens}. */
  readonly maxTokens?: number;
  /** Issues every HTTP request. Absent uses the global `fetch`. Inject a fake so `propose` never touches the network. */
  readonly fetch?: FetchLike;
  /** Supplies the provider's notion of the current time (epoch ms), used only to measure `Usage.latencyMs`. Absent uses `Date.now`. */
  readonly now?: () => number;
}

/**
 * An {@link "../provider.js".Provider} backed by an OpenAI-compatible
 * `/chat/completions` endpoint.
 */
export class OpenAIProvider implements Provider {
  readonly #baseURL: string;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #maxTokens: number;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #lastMode: ResponseFormatMode | "" = "";

  /**
   * Builds a provider from `config`. Throws {@link MissingBaseURLError} if
   * `baseURL` is empty, or {@link MissingModelError} if `model` is empty.
   */
  constructor(config: Config) {
    if (!config.baseURL) throw new MissingBaseURLError();
    if (!config.model) throw new MissingModelError();

    this.#baseURL = config.baseURL.replace(/\/+$/, "");
    this.#model = config.model;
    this.#apiKey = config.apiKey ?? "";
    this.#maxTokens = config.maxTokens && config.maxTokens > 0 ? config.maxTokens : DefaultMaxTokens;
    this.#fetch = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#now = config.now ?? Date.now;
  }

  /**
   * Reports which `response_format` mode served the most recently completed
   * `propose` call, or `undefined` before the first call. A test/diagnostic
   * hook, never required for correct use.
   */
  lastResponseFormatMode(): ResponseFormatMode | undefined {
    return this.#lastMode === "" ? undefined : this.#lastMode;
  }

  /**
   * Renders `prompt`, POSTs it for exactly one structured-output JSON reply
   * (with the json_object fallback on rejection), and maps that reply to a
   * proposal. It never returns a fabricated proposal: any failure to obtain
   * and parse a valid reply throws a typed error.
   */
  async propose(prompt: Prompt): Promise<ProposeResult> {
    const { system, user } = renderPrompt(prompt);

    const start = this.#now();
    const { response, mode, error } = await this.#completeWithFallback(system, user);
    const latencyMs = this.#now() - start;
    this.#lastMode = mode;
    if (error || response === undefined) {
      throw error ?? new Error("actor/openai: no response");
    }

    const usage: Usage = {
      model: response.model || this.#model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
      // cost stays absent unconditionally — see the module doc comment.
    };

    const proposal = proposalFromResponse(response, prompt, usage);
    return { proposal, usage };
  }

  /**
   * Performs the primary json_schema request and, only when the server's
   * failure is classified as retryable, exactly one json_object fallback with
   * the schema restated in the system prompt. Returns which mode produced (or
   * last attempted) the result, so `propose` can record it regardless of
   * outcome.
   */
  async #completeWithFallback(
    system: string,
    user: string,
  ): Promise<{ response?: ChatCompletionResponse; mode: ResponseFormatMode; error?: Error }> {
    const first = await this.#doRequest(system, user, jsonSchemaResponseFormat());
    if (first.error === undefined) {
      return { response: first.response, mode: "json_schema" };
    }
    if (!first.canFallback) {
      return { mode: "json_schema", error: first.error };
    }

    const fallbackSystem = system + "\n\n" + jsonObjectFallbackInstructions;
    const second = await this.#doRequest(fallbackSystem, user, jsonObjectResponseFormat());
    if (second.error !== undefined) {
      return { mode: "json_object_fallback", error: new FallbackFailedError(first.error, second.error) };
    }
    return { response: second.response, mode: "json_object_fallback" };
  }

  /**
   * POSTs one `/chat/completions` request and returns the parsed success
   * response, or an error plus whether that error is eligible for the
   * json_object fallback — never both a response and an error.
   */
  async #doRequest(
    system: string,
    user: string,
    responseFormat: Record<string, unknown>,
  ): Promise<{ response?: ChatCompletionResponse; canFallback: boolean; error?: Error }> {
    const reqBody = {
      model: this.#model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: responseFormat,
      max_tokens: this.#maxTokens,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#apiKey !== "") headers["Authorization"] = `Bearer ${this.#apiKey}`;

    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(`${this.#baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
      });
    } catch (err) {
      // A transport-level failure never reached the server at all — nothing to
      // fall back from, so this is never retryable.
      return { canFallback: false, error: new Error(`actor/openai: request failed: ${(err as Error).message}`) };
    }

    const body = await res.text();
    if (res.status < 200 || res.status >= 300) {
      return { canFallback: retryable(res.status), error: classifyStatusError(res.status, body) };
    }

    try {
      return { response: JSON.parse(body) as ChatCompletionResponse, canFallback: false };
    } catch (err) {
      return {
        canFallback: false,
        error: new Error(`actor/openai: decode response: ${(err as Error).message} (body: ${truncateBody(body)})`),
      };
    }
  }
}

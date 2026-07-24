/**
 * Wire types and HTTP-failure classification for the OpenAI-compatible
 * `/chat/completions` endpoint, ported from the Go runtime's
 * `actor/openai/wire.go`.
 */

import { AuthenticationError, RateLimitError } from "./errors.js";

/**
 * The subset of an OpenAI-compatible `POST /chat/completions` success response
 * body `propose` needs: the first choice's message content (and the two
 * reasoning-bearing field names some reasoning models route that text into
 * instead), that choice's `finish_reason`, the model id the server actually
 * served, and, when present, token usage. Every OpenAI-compatible server this
 * package targets (OpenAI, Ollama, LM Studio, OpenRouter, vLLM) emits at least
 * this much.
 */
export interface ChatCompletionResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string;
      /** The LM Studio/DeepSeek-style field a reasoning model's server can route the ENTIRE reply into, leaving `content` empty. */
      reasoning_content?: string;
      /** An alternate field name a minority of other OpenAI-compatible servers use for the same purpose. */
      reasoning?: string;
    };
    finish_reason?: string;
  }[];
  /** Absent when the server omits the block entirely (some do); either way token counts stay zero, never guessed. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/** The OpenAI-style error response body: `{"error": {"message": ..., "type": ...}}`. */
interface ErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
  };
}

/**
 * Reports whether an HTTP failure status is eligible for the one-shot
 * json_object fallback: every status EXCEPT the two classified as definitively
 * not fixable by changing `response_format` — 401/403 (authentication) and 429
 * (rate limit). An unrecognised failure status is treated the same as an
 * explicit 400 (still eligible), since some servers reject an unsupported
 * `response_format` with an arbitrary 4xx/5xx.
 */
export function retryable(status: number): boolean {
  switch (status) {
    case 401:
    case 403:
    case 429:
      return false;
    default:
      return true;
  }
}

/** Maps an HTTP failure status/body to this package's error taxonomy. */
export function classifyStatusError(status: number, body: string): Error {
  let message = "";
  try {
    const env = JSON.parse(body) as ErrorEnvelope;
    message = env.error?.message ?? "";
  } catch {
    // best-effort; leave message empty on non-JSON body
  }
  if (message === "") message = truncateBody(body);

  switch (status) {
    case 401:
    case 403:
      return new AuthenticationError(new Error(`status ${status}: ${message}`));
    case 429:
      return new RateLimitError(new Error(`status ${status}: ${message}`));
    default:
      return new Error(`actor/openai: request failed: status ${status}: ${message}`);
  }
}

/** Renders `body` as a bounded string for an error message. */
export function truncateBody(body: string): string {
  const MAX = 200;
  return body.length > MAX ? body.slice(0, MAX) + "…" : body;
}

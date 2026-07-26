/**
 * The transport seam: delivering platform-native payloads to and from a
 * black-box bot, independent of how the bot is hosted.
 *
 * @remarks
 * Decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}
 * names two transports sharing one mental model — "point your bot at
 * Chatwright" — and this module states the seam between them: the runtime
 * talks to a {@link BotTransport}, never to an iframe or an HTTP client
 * directly.
 */

import { IframeHost, type IframeHostAttachment, type IframeHostOptions } from "../protocol/iframe-host.js";

/**
 * A single method call a bot makes against the emulated platform (for
 * example a Telegram Bot API `sendMessage` call), as delivered to a
 * {@link BotTransport} consumer.
 *
 * @remarks
 * `payload` is the platform-native call body, opaque to the transport
 * layer — see {@link "../platform/codec.js".PlatformCodec}.
 */
export interface BotCall {
  readonly id: string;
  readonly method: string;
  readonly payload: unknown;
}

/**
 * The transport-agnostic channel between the runtime and one black-box bot
 * instance.
 *
 * @remarks
 * Both transports below implement this interface identically from the
 * runtime's perspective: the runtime never branches on transport kind once
 * a `BotTransport` is constructed. `deliverUpdate` pushes a platform update
 * to the bot; `onCall` registers the runtime's handler for method calls the
 * bot makes back; `respond` returns the emulated platform's result for a
 * previously received call, correlated by `id` (mirrors {@link
 * "../protocol/envelope.js".Envelope.id}); `close` releases whatever
 * resources the transport holds (a `MessagePort`, an HTTP listener, …).
 */
export interface BotTransport {
  deliverUpdate(update: unknown): void;
  onCall(handler: (call: BotCall) => void): void;
  respond(id: string, result: unknown): void;
  close(): void;
}

/**
 * The iframe + postMessage transport: `<iframe src="bot-url">` plus the
 * envelope handshake, channel handoff and steady-state traffic described in
 * {@link "../protocol/envelope.js"}.
 *
 * @remarks
 * A thin {@link BotTransport}-shaped wrapper over {@link IframeHost}, which
 * owns the actual handshake, port management and call correlation (see
 * `../protocol/iframe-host.js` for the full contract, including the
 * DOM-free `"port"` attachment used by this package's own tests). This
 * class exists only so callers that think in terms of "the iframe
 * transport" can import it from the transport module the scaffold
 * originally named, without needing to know `IframeHost` is where the
 * implementation actually lives.
 */
export class IframeTransport implements BotTransport {
  private readonly host: IframeHost;

  constructor(options: IframeHostOptions, attachment: IframeHostAttachment) {
    this.host = new IframeHost(options, attachment);
  }

  /** Whether the handshake has completed and a steady-state port is active. */
  get connected(): boolean {
    return this.host.connected;
  }

  deliverUpdate(update: unknown): void {
    this.host.deliverUpdate(update);
  }

  onCall(handler: (call: BotCall) => void): void {
    this.host.onCall(handler);
  }

  respond(id: string, result: unknown): void {
    this.host.respond(id, result);
  }

  close(): void {
    this.host.close();
  }
}

/** Fetch-compatible function accepted by {@link HttpTransport}. */
export type HttpTransportFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Construction options for the implemented webhook-delivery slice of {@link HttpTransport}. */
export interface HttpTransportOptions {
  /** The black-box bot's webhook endpoint. */
  readonly webhookURL: string;
  /** Additional webhook request headers, for example a Telegram secret-token header. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable fetch implementation; defaults to the environment's global `fetch`. */
  readonly fetch?: HttpTransportFetch;
  /** Optional asynchronous delivery-error observer. */
  readonly onError?: (error: Error) => void;
}

/**
 * The remote-HTTPS transport's webhook-delivery slice.
 *
 * It posts platform updates to a black-box bot and, crucially, processes the
 * platform method a bot may return directly in the successful webhook HTTP
 * response body. Telegram permits this latency-saving response form. Both
 * JSON and `application/x-www-form-urlencoded` bodies are normalised into a
 * regular {@link BotCall}, so `Session` routes them through the same platform
 * codec and journal path as calls received over the iframe transport.
 *
 * The broader emulated platform API listener and long-polling surface remain
 * deferred to I-68. This class therefore does not yet provide a Bot API base
 * URL for independent bot requests; it faithfully covers webhook delivery
 * and inline webhook responses only.
 */
export class HttpTransport implements BotTransport {
  readonly #options: HttpTransportOptions;
  readonly #fetch: HttpTransportFetch;
  readonly #abortController = new AbortController();
  readonly #pendingInlineCalls = new Map<string, string>();
  #callHandler: ((call: BotCall) => void) | undefined;
  #deliveryTail: Promise<void> = Promise.resolve();
  #deliveryError: Error | undefined;
  #nextCallID = 0;
  #closed = false;

  constructor(options: HttpTransportOptions) {
    const webhookURL = options.webhookURL.trim();
    if (!webhookURL) {
      throw new Error("HttpTransport: webhookURL is required");
    }
    let parsedURL: URL;
    try {
      parsedURL = new URL(webhookURL);
    } catch {
      throw new Error(`HttpTransport: invalid webhookURL ${JSON.stringify(options.webhookURL)}`);
    }
    if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
      throw new Error("HttpTransport: webhookURL must use http or https");
    }
    this.#options = { ...options, webhookURL };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  deliverUpdate(update: unknown): void {
    this.#requireOpen();
    const delivery = this.#deliveryTail.then(() => this.#postUpdate(update));
    this.#deliveryTail = delivery.catch((cause: unknown) => {
      const error = asError(cause);
      this.#deliveryError ??= error;
      this.#options.onError?.(error);
    });
  }

  onCall(handler: (call: BotCall) => void): void {
    this.#requireOpen();
    this.#callHandler = handler;
  }

  respond(id: string, result: unknown): void {
    const method = this.#pendingInlineCalls.get(id);
    if (method === undefined) {
      throw new Error(`HttpTransport.respond: no pending inline call with id ${JSON.stringify(id)}`);
    }
    this.#pendingInlineCalls.delete(id);
    if (isRecord(result) && result["ok"] === false) {
      const code = typeof result["error_code"] === "number" ? ` ${result["error_code"]}` : "";
      const description =
        typeof result["description"] === "string" ? `: ${result["description"]}` : "";
      throw new Error(`HttpTransport: inline webhook method ${method} failed${code}${description}`);
    }
    // Telegram does not receive a second response for a method it supplied in
    // the webhook response body. The emulated result has already served its
    // purpose by validating and journalling the method through Session.
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    this.#pendingInlineCalls.clear();
    this.#callHandler = undefined;
  }

  /**
   * Waits until every webhook delivery queued so far has settled.
   *
   * Scenario expectations normally observe the journal and do not need this;
   * it is useful for lifecycle code and for surfacing asynchronous transport
   * failures without relying on an `onError` callback.
   */
  async waitForIdle(): Promise<void> {
    await this.#deliveryTail;
    if (this.#deliveryError) throw this.#deliveryError;
  }

  async #postUpdate(update: unknown): Promise<void> {
    const headers = new Headers(this.#options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.#fetch(this.#options.webhookURL, {
      method: "POST",
      headers,
      body: JSON.stringify(update),
      signal: this.#abortController.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      const detail = responseBody.trim();
      throw new Error(
        `HttpTransport: webhook returned status ${response.status}` +
          (detail ? `: ${detail.slice(0, 1 << 20)}` : ""),
      );
    }
    const inlineCall = parseInlineWebhookCall(
      responseBody,
      response.headers.get("content-type") ?? "",
    );
    if (!inlineCall) return;
    if (!this.#callHandler) {
      throw new Error("HttpTransport: inline webhook method received before onCall was registered");
    }
    const id = `http-inline-${++this.#nextCallID}`;
    this.#pendingInlineCalls.set(id, inlineCall.method);
    try {
      this.#callHandler({ id, method: inlineCall.method, payload: inlineCall.params });
    } catch (cause) {
      this.#pendingInlineCalls.delete(id);
      throw cause;
    }
    if (this.#pendingInlineCalls.has(id)) {
      this.#pendingInlineCalls.delete(id);
      throw new Error(`HttpTransport: inline webhook method ${inlineCall.method} was not answered`);
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("HttpTransport: transport is closed");
  }
}

interface InlineWebhookCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function parseInlineWebhookCall(body: string, contentType: string): InlineWebhookCall | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  const isJSON = contentType.toLowerCase().startsWith("application/json") || trimmed.startsWith("{");
  if (isJSON) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (cause) {
      throw new Error(`HttpTransport: invalid inline platform JSON: ${asError(cause).message}`);
    }
    if (!isRecord(value) || typeof value["method"] !== "string" || value["method"] === "") {
      return undefined;
    }
    const { method, ...params } = value;
    return { method, params };
  }

  const values = new URLSearchParams(trimmed);
  const method = values.get("method") ?? "";
  if (!method) return undefined;
  values.delete("method");
  return { method, params: Object.fromEntries(values.entries()) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

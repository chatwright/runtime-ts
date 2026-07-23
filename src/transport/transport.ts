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

/**
 * The remote-HTTPS transport: the runtime exposes an emulated platform API
 * base URL; the bot swaps its API root, registers a webhook or long-polls,
 * and calls platform methods against the emulated server — the same
 * pattern the Go runtime already proves for `BotAPIURL()`-pointed bots
 * (decision 0012's "Context").
 *
 * @remarks Scaffold — specified in research item I-68.
 *
 * No construction logic exists yet; the constructor is a placeholder that
 * intentionally throws so this class cannot be mistaken for a working
 * transport before I-68 lands.
 */
export class HttpTransport implements BotTransport {
  constructor() {
    throw new Error(
      "HttpTransport is a scaffold stub — see research item I-68 " +
        "(chatwright/chatwright spec/research/knowledge-platform.md)",
    );
  }

  deliverUpdate(_update: unknown): void {
    throw new Error("not implemented — scaffold stub, see I-68");
  }

  onCall(_handler: (call: BotCall) => void): void {
    throw new Error("not implemented — scaffold stub, see I-68");
  }

  respond(_id: string, _result: unknown): void {
    throw new Error("not implemented — scaffold stub, see I-68");
  }

  close(): void {
    throw new Error("not implemented — scaffold stub, see I-68");
  }
}

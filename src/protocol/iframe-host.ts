/**
 * `IframeHost` — the host side of the iframe postMessage transport described
 * in {@link "./envelope.js"} and normatively specified in
 * {@link https://github.com/chatwright/chatwright/blob/main/formats/bot-protocol/v1/README.md | formats/bot-protocol/v1/README.md}.
 *
 * @remarks
 * `IframeHost` owns everything the protocol README assigns to "the host":
 *
 * - Listening for the bot's {@link HelloMessage}, validating its origin, and
 *   replying with a {@link HelloAckMessage} carrying a freshly transferred
 *   `MessagePort`.
 * - Queueing outbound `update` envelopes, in order, until the handshake
 *   completes, then flushing them.
 * - Resetting the session (closing the old port, dropping in-flight call
 *   bookkeeping) whenever a repeated `hello` arrives.
 * - Correlating a bot's `call` envelopes with the host's `result` envelopes
 *   by `id`, via {@link BotTransport.onCall}/{@link BotTransport.respond}.
 *
 * It implements {@link BotTransport} so a {@link
 * "../session/session.js".Session} can register it exactly like any other
 * bot transport, without knowing it is iframe-backed.
 *
 * **Two attachments, one implementation.** The constructor's second
 * argument is either a `"window"` attachment (a real `<iframe>`'s
 * `contentWindow`, for production use) or a `"port"` attachment (a bare
 * `MessagePort`, for DOM-free tests). Node's global `MessageChannel` +
 * `MessagePort` are structurally compatible with the DOM types this module
 * is written against — see this package's `tsconfig.json`'s `"DOM"` lib
 * entry — so a test can hand `IframeHost` one end of a
 * `new MessageChannel()` and drive the handshake exactly as a real iframe
 * would, with no `jsdom` or browser involved. The one behavioural
 * difference: a `"window"` attachment's hello is origin-checked against
 * `event.origin` (the reason origin validation exists at all — an arbitrary
 * page could otherwise `postMessage` into the host); a `"port"` attachment
 * has no such cross-origin exposure — whoever holds the port reference
 * already has a private channel — so its (optional) `origin` is a test
 * convenience for exercising the same validation path, not a security
 * boundary.
 */

import type { BotCall, BotTransport } from "../transport/transport.js";
import {
  PROTOCOL_VERSION,
  type CallPayload,
  type Envelope,
  type HelloAckMessage,
  type HelloMessage,
} from "./envelope.js";

/** What {@link IframeHost} needs to know before it can validate a handshake. */
export interface IframeHostOptions {
  /** The origin a bot's `hello` must arrive from to be accepted. */
  readonly expectedOrigin: string;
  /** The platform this host expects to speak, repeated on every envelope. */
  readonly platform: string;
}

/** Attach to a real `<iframe>`'s window — the production path. */
export interface WindowAttachment {
  readonly kind: "window";
  /** The window whose `message` events carry the bot's handshake postings. */
  readonly hostWindow: Window;
  /** The iframe's `contentWindow` — only messages from this source are handled. */
  readonly botWindow: Window;
}

/**
 * Attach directly to a `MessagePort` — the DOM-free path used by this
 * package's own tests (via Node's `MessageChannel`) and available to any
 * caller that already has a private channel to a bot (a worker, a same-process
 * embedding, …) and so has no window-level postMessage step to perform.
 */
export interface PortAttachment {
  readonly kind: "port";
  readonly port: MessagePort;
  /**
   * The origin to treat this port's `hello` messages as having arrived
   * from. Defaults to `expectedOrigin` — a directly-held `MessagePort` carries
   * no cross-origin risk to validate against, so trusting it by default is
   * correct, not a shortcut. Set explicitly only to exercise origin-mismatch
   * rejection in a test.
   */
  readonly origin?: string;
}

export type IframeHostAttachment = WindowAttachment | PortAttachment;

/** One call the bot has sent that is awaiting {@link IframeHost.respond}. */
interface PendingCall {
  readonly method: string;
}

/**
 * The host side of the iframe postMessage transport for one bot instance.
 * See the module doc comment for the full contract.
 */
export class IframeHost implements BotTransport {
  private readonly options: IframeHostOptions;
  private readonly attachment: IframeHostAttachment;

  /** The correlation map: call id → the pending call awaiting a `respond()`. */
  private readonly pendingCalls = new Map<string, PendingCall>();
  /** Outbound `update` envelopes queued while no steady-state port exists. */
  private readonly outboundQueue: Envelope[] = [];

  private steadyPort: MessagePort | undefined;
  private callHandler: ((call: BotCall) => void) | undefined;
  private nextUpdateSeq = 0;
  private detachHandshakeListener: (() => void) | undefined;

  constructor(options: IframeHostOptions, attachment: IframeHostAttachment) {
    this.options = options;
    this.attachment = attachment;
    this.attachHandshakeListener();
  }

  /** Whether a handshake has completed and a steady-state port is active. */
  get connected(): boolean {
    return this.steadyPort !== undefined;
  }

  // ---- BotTransport ----------------------------------------------------

  deliverUpdate(update: unknown): void {
    const envelope: Envelope = {
      id: `u-${++this.nextUpdateSeq}`,
      kind: "update",
      platform: this.options.platform,
      payload: update,
    };
    if (this.steadyPort) {
      this.steadyPort.postMessage(envelope);
    } else {
      this.outboundQueue.push(envelope);
    }
  }

  onCall(handler: (call: BotCall) => void): void {
    this.callHandler = handler;
  }

  respond(id: string, result: unknown): void {
    if (!this.pendingCalls.has(id)) {
      throw new Error(
        `IframeHost.respond: no pending call with id ${JSON.stringify(id)} ` +
          "(already answered, or the session was reset by a repeated hello)",
      );
    }
    this.pendingCalls.delete(id);
    if (!this.steadyPort) {
      throw new Error("IframeHost.respond: no active port to send the result on");
    }
    const envelope: Envelope = {
      id,
      kind: "result",
      platform: this.options.platform,
      payload: result,
    };
    this.steadyPort.postMessage(envelope);
  }

  close(): void {
    this.detachHandshakeListener?.();
    this.detachHandshakeListener = undefined;
    this.resetSteadyState();
    this.outboundQueue.length = 0;
    this.callHandler = undefined;
  }

  // ---- Handshake ---------------------------------------------------------

  private attachHandshakeListener(): void {
    const attachment = this.attachment;
    if (attachment.kind === "window") {
      const listener = (event: MessageEvent): void => {
        if (event.source !== attachment.botWindow) return;
        this.handleIncomingHello(event.data, event.origin, (ack, transfer) => {
          attachment.botWindow.postMessage(ack, event.origin, transfer);
        });
      };
      attachment.hostWindow.addEventListener("message", listener);
      this.detachHandshakeListener = () =>
        attachment.hostWindow.removeEventListener("message", listener);
    } else {
      const port = attachment.port;
      const origin = attachment.origin ?? this.options.expectedOrigin;
      const listener = (event: MessageEvent): void => {
        this.handleIncomingHello(event.data, origin, (ack, transfer) => {
          port.postMessage(ack, transfer);
        });
      };
      port.addEventListener("message", listener);
      port.start();
      this.detachHandshakeListener = () => port.removeEventListener("message", listener);
    }
  }

  private handleIncomingHello(
    data: unknown,
    origin: string,
    reply: (ack: HelloAckMessage, transfer: Transferable[]) => void,
  ): void {
    if (!isHelloMessage(data)) return; // not a handshake message for us — ignore
    if (origin !== this.options.expectedOrigin) return; // README: host validates event.origin

    // "A repeated hello after handshake resets the session (the old port is
    // closed)." — true for the very first hello too: there is nothing to
    // reset, so this is a no-op in that case.
    this.resetSteadyState();

    const channel = new MessageChannel();
    this.steadyPort = channel.port1;
    this.wireSteadyPort(channel.port1);

    const ack: HelloAckMessage = {
      chatwright: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      platform: this.options.platform,
    };
    reply(ack, [channel.port2]);

    this.flushQueue();
  }

  private resetSteadyState(): void {
    if (this.steadyPort) {
      this.steadyPort.close();
      this.steadyPort = undefined;
    }
    // The old port is gone: whatever it was waiting on will never resolve.
    this.pendingCalls.clear();
  }

  private wireSteadyPort(port: MessagePort): void {
    port.addEventListener("message", (event: MessageEvent) => {
      this.handleSteadyMessage(event.data as unknown);
    });
    port.start();
  }

  private handleSteadyMessage(data: unknown): void {
    const envelope = data as Partial<Envelope> | null;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind !== "call") return; // only "call" flows bot → host on this port
    if (typeof envelope.id !== "string") return;
    if (!isCallPayload(envelope.payload)) return;

    this.pendingCalls.set(envelope.id, { method: envelope.payload.method });
    this.callHandler?.({
      id: envelope.id,
      method: envelope.payload.method,
      payload: envelope.payload.params,
    });
  }

  private flushQueue(): void {
    if (!this.steadyPort) return;
    const port = this.steadyPort;
    for (const envelope of this.outboundQueue) {
      port.postMessage(envelope);
    }
    this.outboundQueue.length = 0;
  }
}

function isHelloMessage(data: unknown): data is HelloMessage {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate.chatwright === "hello" &&
    typeof candidate.protocolVersion === "string" &&
    typeof candidate.platform === "string" &&
    Array.isArray(candidate.capabilities)
  );
}

function isCallPayload(payload: unknown): payload is CallPayload {
  if (typeof payload !== "object" || payload === null) return false;
  return typeof (payload as Record<string, unknown>).method === "string";
}

/**
 * Test-only support: a minimal fake bot that drives the bot side of the
 * iframe postMessage protocol (see `../protocol/envelope.ts` and
 * `../protocol/iframe-host.ts`) over a raw `MessagePort`, so this package's
 * own tests can exercise {@link "../protocol/iframe-host.js".IframeHost}
 * without a DOM or a real bot page.
 *
 * @remarks Not part of the public API — not re-exported from `index.ts`.
 */

import type { Envelope, HelloMessage } from "../protocol/envelope.js";

/**
 * Resolves after the current macrotask queue drains. `MessagePort` message
 * delivery is asynchronous — even a same-process `postMessage` is not
 * observable synchronously or within a microtask — so every test that posts
 * a message and then asserts on its effect must `await` this first.
 */
export function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake bot driving one `MessagePort` handshake channel from the bot's side. */
export class FakeBot {
  private steady: MessagePort | undefined;
  readonly steadyMessages: Envelope[] = [];

  constructor(private readonly handshakePort: MessagePort) {
    this.handshakePort.addEventListener("message", (event: MessageEvent) => {
      this.handleHandshakeMessage(event);
    });
    this.handshakePort.start();
  }

  private handleHandshakeMessage(event: MessageEvent): void {
    const data = event.data as { chatwright?: string } | null;
    if (data && data.chatwright === "hello-ack") {
      const port = event.ports[0];
      if (port) {
        this.steady = port;
        port.addEventListener("message", (portEvent: MessageEvent) => {
          this.steadyMessages.push(portEvent.data as Envelope);
        });
        port.start();
      }
    }
  }

  /** Whether a `hello-ack` (and its transferred steady port) has been received. */
  get connected(): boolean {
    return this.steady !== undefined;
  }

  /** Posts a `hello`, opening (or resetting) the handshake. */
  sendHello(platform = "telegram", capabilities: readonly string[] = []): void {
    const hello: HelloMessage = { chatwright: "hello", protocolVersion: "1", platform, capabilities };
    this.handshakePort.postMessage(hello);
  }

  /** Posts a `call` envelope on the steady-state port. Requires a completed handshake. */
  call(id: string, method: string, params: unknown): void {
    if (!this.steady) throw new Error("FakeBot.call: handshake not complete yet");
    const envelope: Envelope = { id, kind: "call", platform: "telegram", payload: { method, params } };
    this.steady.postMessage(envelope);
  }

  /** Result envelopes received so far, in arrival order. */
  results(): Envelope[] {
    return this.steadyMessages.filter((envelope) => envelope.kind === "result");
  }

  /** Update envelopes received so far, in arrival order. */
  updates(): Envelope[] {
    return this.steadyMessages.filter((envelope) => envelope.kind === "update");
  }

  close(): void {
    this.handshakePort.close();
    this.steady?.close();
  }
}

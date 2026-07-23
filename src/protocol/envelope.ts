/**
 * The iframe postMessage envelope for in-browser black-box bots.
 *
 * @remarks
 * See decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012: black-box bot protocol}.
 *
 * The runtime and an iframe-hosted bot exchange three message shapes over
 * three phases:
 *
 * 1. **Handshake** — on load the host `window` sends a {@link HelloMessage}
 *    to the bot's `window` via `postMessage`; the bot answers with a
 *    {@link HelloAckMessage} declaring its protocol version, platform and
 *    capability keys (decision
 *    {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0011-executable-knowledge-graph.md | 0011}).
 *    The host validates the bot's origin against the manifest's declared
 *    origin at this point only — origin is never re-checked per message.
 * 2. **Channel handoff** — after the handshake the host transfers a
 *    dedicated `MessagePort` to the bot; all subsequent traffic moves off
 *    `window.postMessage` and onto the port, isolating each embedded bot
 *    instance from every other iframe on the page.
 * 3. **Steady state** — {@link Envelope} messages flow over the port in
 *    both directions. `payload` is always opaque: platform-native JSON
 *    (Telegram Bot API updates and method calls, WhatsApp Cloud API
 *    payloads, and so on) that the envelope layer never parses or
 *    interprets. The envelope owns identity and sequencing; the payload
 *    owns domain meaning.
 *
 * **Ready-queueing**: updates the host wants to deliver before the bot's
 * hello-ack arrives (autostart, replay) are buffered by the runtime and
 * flushed in order once the handshake completes, so delivery never races
 * the iframe's boot.
 *
 * The full envelope specification — error semantics, timeouts, port
 * lifecycle, multi-chat routing, version negotiation edge cases, iframe
 * `sandbox`/CSP attributes — is deliberately out of scope here; it is
 * research backlog item I-68 in
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/research/knowledge-platform.md | knowledge-platform.md}.
 * This module states shape only.
 */

/**
 * The envelope protocol version this package implements.
 *
 * @remarks
 * Carried on every {@link HelloMessage} and {@link HelloAckMessage} so a
 * host and bot can detect a version mismatch at handshake time. Version
 * negotiation semantics (what happens on mismatch) are deferred to I-68.
 */
export const PROTOCOL_VERSION = "1";

/**
 * Sent by the host to an iframe-hosted bot on load, opening the handshake.
 *
 * @remarks
 * `platform` names the platform the host expects the bot to speak (for
 * example `"telegram"`); the bot's {@link HelloAckMessage} confirms or
 * disputes it.
 */
export interface HelloMessage {
  readonly chatwright: "hello";
  readonly protocolVersion: string;
  readonly platform: string;
}

/**
 * Sent by an iframe-hosted bot in reply to a {@link HelloMessage},
 * completing the handshake before channel handoff.
 *
 * @remarks
 * `capabilities` is a list of capability keys (decision 0011) the bot
 * declares fidelity for — the same dotted-path vocabulary used by platform
 * emulator fidelity tables and compatibility data. An empty list is a
 * legitimate declaration of "no capabilities beyond the platform baseline",
 * never an omission to be inferred.
 */
export interface HelloAckMessage {
  readonly chatwright: "hello-ack";
  readonly protocolVersion: string;
  readonly platform: string;
  readonly capabilities: readonly string[];
}

/**
 * A single message on the steady-state `MessagePort` channel, after
 * handshake and handoff.
 *
 * @remarks
 * - `id` correlates a bot-initiated `"call"` (a platform method invocation,
 *   such as Telegram's `sendMessage`) with the host's matching `"result"`
 *   (the platform's response wire shape for that call). Host-initiated
 *   `"update"` envelopes (a platform update delivered to the bot) do not
 *   require a `"result"` reply in this envelope layer — the bot's reaction,
 *   if any, arrives as its own `"call"` envelope(s).
 * - `platform` repeats the platform named at handshake, so a host managing
 *   several iframes can demultiplex without inspecting `payload`.
 * - `payload` is always `unknown`: the platform-native JSON body. The
 *   envelope layer never parses it — only a {@link
 *   "../platform/codec.js".PlatformCodec} does that, and only for the
 *   platform it implements.
 */
export interface Envelope {
  readonly id: string;
  readonly kind: "update" | "call" | "result";
  readonly platform: string;
  readonly payload: unknown;
}

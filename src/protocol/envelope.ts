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
 * 1. **Handshake — the bot speaks first.** Once its listener is attached and
 *    it is ready to serve, the bot posts a {@link HelloMessage} to
 *    `window.parent`, declaring its protocol version, platform and
 *    capability keys (decision
 *    {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0011-executable-knowledge-graph.md | 0011}) —
 *    what it exercises, informative for fidelity display, never an access
 *    control. The host validates `event.origin` against the origin the
 *    bot's manifest declares (or the origin the operator configured) and
 *    replies to that exact origin with a {@link HelloAckMessage}, which
 *    carries no capabilities of its own. Origin is checked at handshake
 *    only — never re-validated per message.
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
 * Sent by an iframe-hosted bot to `window.parent` as soon as its listener is
 * attached and it is ready to serve, opening the handshake — the bot speaks
 * first; the host never addresses a bot it has not heard from.
 *
 * @remarks
 * `platform` names the platform the bot speaks (for example `"telegram"`);
 * the host's {@link IframeHostOptions} (see
 * `../protocol/iframe-host.js`) states which platform it expects, but this
 * envelope layer does not itself gate on a mismatch — see I-68.
 * `capabilities` is a list of capability keys (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0011-executable-knowledge-graph.md | 0011})
 * the bot declares it exercises — the same dotted-path vocabulary used by
 * platform emulator fidelity tables and compatibility data. It is
 * informative for fidelity display, never an access control; an empty list
 * is a legitimate declaration of "no capabilities beyond the platform
 * baseline", never an omission to be inferred.
 */
export interface HelloMessage {
  readonly chatwright: "hello";
  readonly protocolVersion: string;
  readonly platform: string;
  readonly capabilities: readonly string[];
}

/**
 * Sent by the host in reply to a validated {@link HelloMessage}, completing
 * the handshake and carrying the transferred `MessagePort` that all
 * steady-state traffic moves onto. It declares no capabilities of its own —
 * capabilities are a property of the bot, not the host.
 */
export interface HelloAckMessage {
  readonly chatwright: "hello-ack";
  readonly protocolVersion: string;
  readonly platform: string;
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

/**
 * The shape of a `"call"` envelope's `payload` — the one place the envelope
 * layer itself (rather than a {@link "../platform/codec.js".PlatformCodec})
 * knows something about `payload`'s structure, because the bot-protocol
 * README defines it directly: "`payload` is `{"method": "sendMessage",
 * "params": { }}` — the platform method name and its parameters exactly as
 * the bot would POST them to the real API." `params` itself stays opaque,
 * platform-native JSON.
 */
export interface CallPayload {
  readonly method: string;
  readonly params: unknown;
}

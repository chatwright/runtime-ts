/**
 * The platform codec seam: building and parsing one platform's native wire
 * payloads, isolated from every other platform.
 *
 * @remarks
 * Mirrors the role the Go runtime's `telegram` package plays for the Go
 * emulator (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}):
 * a `PlatformCodec` is the only thing in the runtime allowed to know the
 * shape of a given platform's updates and method calls. Neither the
 * envelope layer ({@link "../protocol/envelope.js"}) nor the transport
 * layer ({@link "../transport/transport.js"}) ever inspects `payload`
 * directly — they hand it, opaque, to the codec for the platform named
 * alongside it.
 *
 * Per-platform packages implement this interface — Telegram first,
 * following the Go runtime's platform ordering (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0002-platform-neutral-telegram-first.md | 0002}).
 * None ship in this scaffold.
 */

/**
 * Builds and parses platform-native payloads for one platform, and declares
 * the fidelity slice it covers.
 *
 * @remarks
 * `capabilities` lists the capability keys (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0011-executable-knowledge-graph.md | 0011})
 * this codec's emulation honestly supports — the same dotted-path
 * vocabulary a {@link "../protocol/envelope.js".HelloMessage} declares
 * for a bot. Fidelity is declared, never assumed (decision 0008): a
 * capability key absent from this list must be treated as unsupported by
 * every consumer, not silently approximated.
 *
 * This scaffold states the seam only; no codec implementation — Telegram
 * or otherwise — exists yet. See research item I-67 for the browser
 * Telegram emulator's first fidelity slice.
 */
export interface PlatformCodec {
  readonly platform: string;
  readonly capabilities: readonly string[];
}

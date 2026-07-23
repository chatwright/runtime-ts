/**
 * The platform codec seam: building and parsing one platform's native wire
 * payloads, isolated from every other platform.
 *
 * @remarks
 * Mirrors the role the Go runtime's `telegram`/`whatsapp` packages play for
 * the Go emulator (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}):
 * a `PlatformCodec` is the only thing in the runtime allowed to know the
 * shape of a given platform's updates and method calls. Neither the
 * envelope layer ({@link "../protocol/envelope.js"}) nor the transport
 * layer ({@link "../transport/transport.js"}) ever inspects `payload`
 * directly — they hand it, opaque, to the codec for the platform named
 * alongside it. {@link "../session/session.js".Session} is this seam's one
 * consumer: it drives whichever `PlatformCodec` it is constructed with,
 * never assuming Telegram specifically.
 *
 * Per-platform packages implement this interface — Telegram first,
 * following the Go runtime's platform ordering (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0002-platform-neutral-telegram-first.md | 0002}),
 * WhatsApp second (`src/whatsapp/codec.ts`, a text-only slice mirroring
 * `runtime-go`'s `whatsapp.Emulator`). Both are concrete classes with far
 * more surface than this interface states (per-platform update/result wire
 * types, private helpers) — this interface is deliberately only what
 * {@link "../session/session.js".Session} needs to stay codec-agnostic, not
 * a full description of either codec.
 */

import type { Journal } from "../journal/journal.js";

/**
 * What a {@link PlatformCodec.handleCall} implementation needs from its
 * caller: journal access, resolved per chat — mirrors how a real platform
 * API call's `chat_id`/`to` is what an `Emulator` uses to route into its
 * own per-chat journal store.
 */
export interface PlatformCallContext {
  /** Returns (creating if necessary) the journal for a given chat id. */
  readonly journalFor: (chatId: number) => Journal;
}

/**
 * A platform codec's own identity for a run-bundle actor's
 * `platformIdentities` entry (see
 * {@link "../session/session.js".Session.toBundle}). `userId` is required —
 * every platform this runtime emulates has *some* stable numeric identity
 * for its emulated bot (Telegram's fixed bot user id; WhatsApp's emulated
 * business phone number) — `firstName`/`username` are optional the same
 * way the wire identities they describe are.
 */
export interface PlatformBotIdentity {
  readonly userId: number;
  readonly firstName?: string;
  readonly username?: string;
}

/**
 * A neutral participant identity, structurally shared by every platform
 * codec's own user type (for example `TelegramUser`, `WhatsAppUser`) rather
 * than re-declared per platform — mirrors Go's single `platform.User` type,
 * reused as-is by both `telegram.Emulator` and `whatsapp.Emulator`.
 */
export interface PlatformUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
}

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
 * `buildTextUpdate` and `handleCall` are required of every codec;
 * `buildCallbackUpdate` is optional — a text-only codec (WhatsApp's slice
 * today) simply does not declare it, and {@link
 * "../session/session.js".Session.submitClick} reports an honest error
 * rather than assuming every platform supports interactive actions.
 */
export interface PlatformCodec {
  readonly platform: string;
  readonly capabilities: readonly string[];
  readonly botIdentity: PlatformBotIdentity;

  /** Builds a platform-native update for a user's submitted text, journalling the inbound entry. */
  buildTextUpdate(chatId: number, user: PlatformUser, text: string, journal: Journal): unknown;

  /**
   * Builds a platform-native update for a user clicking an interactive
   * action, journalling the inbound entry. Optional: a codec whose platform
   * slice has no interactive-action support (declared via `capabilities`)
   * omits this method entirely rather than implementing a stub that would
   * misrepresent fidelity.
   */
  buildCallbackUpdate?(
    chatId: number,
    user: PlatformUser,
    targetMessageId: number,
    actionId: string,
    journal: Journal,
  ): unknown;

  /** Parses and answers one platform method call, journalling the outbound entry (or an `"uncaptured"` entry for anything unsupported). */
  handleCall(method: string, params: unknown, ctx: PlatformCallContext): unknown;
}

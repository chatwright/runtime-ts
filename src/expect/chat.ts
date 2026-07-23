/**
 * `Chat` — a PlaygroundChat-style deterministic scenario handle over one
 * chat of a running {@link "../session/session.js".Session}: `sendText`,
 * `click`, `expectBotMessage`, `expectEdited`. The TypeScript twin of
 * `runtime-go`'s `cw.Chat` (`chatwright/runtime-go/cw/chat.go`) and
 * `cw.BotMessage`'s waiting half (`chatwright/runtime-go/cw/expect.go`),
 * ported as an algorithm — never shared as code — per decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}.
 *
 * @remarks
 * **Consumption cursor.** Exactly like Go's `cw.Chat`, each `Chat` tracks
 * how many bot messages have been consumed (`expectBotMessage` calls that
 * resolved) so a scenario reads a chat's outbound messages once each, in
 * order — a second `expectBotMessage()` never re-observes a message a prior
 * call already consumed, and it never skips one either. `expectEdited`
 * targets a specific message identity (`messageId` + `version`) instead and
 * does **not** advance this cursor, matching Go precisely (only the
 * `WaitForMessage` path increments `consumed`; the `WaitForEdit` path never
 * does).
 *
 * **No polling.** Waiting is entirely subscribe-driven — see
 * {@link "./wait.js".waitForCondition} — never a `setInterval`/re-check
 * loop; the only timer involved is the safety-timeout deadline.
 *
 * **Deliberate deviations from `runtime-go`, recorded here rather than
 * scattered across call sites** (see `docs/architecture.md` for the fuller
 * writeup):
 *
 * - **`within()` asserts, it does not extend the wait.** Go's `Within(d)`
 *   is called on an *unresolved* handle and, if `d` exceeds the configured
 *   safety timeout, silently extends how long Chatwright keeps listening
 *   before falling back to a bare timeout failure. That coupling only works
 *   because Go's `BotMessage` exists (and can be configured) before it
 *   resolves. This runtime's `expectBotMessage`/`expectEdited` are `async`
 *   and only ever hand back a `BotMessageExpectation` *after* the message
 *   has already arrived, so there is no "not yet resolved" object to attach
 *   a budget to beforehand. `within(ms)` is therefore a pure post-arrival
 *   latency assertion against the already-recorded latency; callers who
 *   want a generous observation window pass a larger `timeoutMs` to
 *   `expectBotMessage`/`expectEdited` directly. One consequence: Go's
 *   "`Within` called after resolution is a usage error" guard has no
 *   equivalent here — it is structurally impossible to call `within()`
 *   before arrival, since the object it lives on doesn't exist yet.
 * - **Latency is measured in real wall-clock time**
 *   (`Date.now()`), independent of whatever {@link
 *   "../journal/in-memory-journal.js".Clock} the `Session` was constructed
 *   with for journal-entry/bundle timestamps. Go has no injectable clock at
 *   all (the emulator always uses `time.Now()`), so this is the closest
 *   equivalent — measuring a `Session` configured with a fixed/tick clock
 *   (as `session.test.ts` does for schema-validation determinism) would
 *   otherwise produce meaningless latencies.
 * - **`click(actionIdOrLabel)` targets the chat's most recently resolved
 *   message**, not an explicit `(row, col)` coordinate the way Go's
 *   `BotMessage.ExpectAction(row, col).Click()` does. This matches a
 *   Playground chat's UI model directly — the user can only click a button
 *   on the bubble currently on screen — and is simpler for scenario authors
 *   than plumbing coordinates through. `expectActions(...)` still lets a
 *   scenario assert the full row layout first.
 * - **Method names use an `expect` prefix** (`expectText`, `expectActions`,
 *   `expectEdited`) rather than Go's bare `Text`/`ExpectAction`, and `text()`
 *   is a plain getter distinct from the `expectText(want)` assertion —
 *   naming only, not a semantic difference.
 */

import type { TelegramUser } from "../telegram/codec.js";
import type { Session } from "../session/session.js";
import type { JournalAction, JournalEntry } from "../journal/journal.js";
import { BotMessageExpectation, type MessageRef } from "./bot-message.js";
import { renderTranscript } from "./transcript.js";
import { latestEntryForMessage, nthOutboundMessage, waitForCondition } from "./wait.js";

/** The wall-clock ceiling `expectBotMessage`/`expectEdited` wait for a bot reply, unless overridden per call. Mirrors `runtime-go`'s `defaultSafetyTimeout` (5s). */
export const DEFAULT_SAFETY_TIMEOUT_MS = 5000;

/** Options accepted by {@link Chat.expectBotMessage} and {@link Chat.expectEdited}. */
export interface ExpectOptions {
  /** Overrides {@link DEFAULT_SAFETY_TIMEOUT_MS} for this call only. */
  readonly timeoutMs?: number;
}

/** Options accepted by {@link chatOf}. Only honored the first time a given `(session, chatId)` pair is addressed — see {@link chatOf}. */
export interface ChatOfOptions {
  readonly safetyTimeoutMs?: number;
}

/**
 * A PlaygroundChat-style scenario handle over one chat: drive it with
 * `sendText`/`click`, assert on it with `expectBotMessage`/`expectEdited`.
 * Obtain one via {@link chatOf} rather than constructing directly.
 */
export class Chat {
  private consumed = 0; // how many bot messages to this chat have been consumed by expectBotMessage
  private lastSentAt = Date.now(); // wall-clock time of the most recent inbound action (sendText/click)
  private current: { readonly messageId: number; readonly actions: readonly (readonly JournalAction[])[] } | undefined;

  constructor(
    private readonly session: Session,
    private readonly chatId: number,
    private readonly user: TelegramUser,
    private readonly safetyTimeoutMs: number = DEFAULT_SAFETY_TIMEOUT_MS,
  ) {}

  /** Delivers a user's text message from this chat's user to the bot-under-test. Returns `this` for chaining. */
  sendText(text: string): this {
    this.lastSentAt = Date.now();
    this.session.submitText(this.chatId, this.user, text);
    return this;
  }

  /**
   * Clicks the action (button) identified by `actionIdOrLabel` — matched
   * against either the action's stable id (Telegram `callback_data`) or its
   * visible label — on the chat's most recently resolved bot message (see
   * the module doc comment for why this targets "the current message"
   * rather than an explicit coordinate). Throws if no message has been
   * resolved yet, or no action on it matches. Returns `this` for chaining.
   */
  click(actionIdOrLabel: string): this {
    if (!this.current) {
      throw new Error(
        `chatwright: click(${JSON.stringify(actionIdOrLabel)}) called with no current bot message — ` +
          `call expectBotMessage() or expectEdited() first\n${this.transcript()}`,
      );
    }
    const action = findAction(this.current.actions, actionIdOrLabel);
    if (!action) {
      throw new Error(
        `chatwright: no action with id or label ${JSON.stringify(actionIdOrLabel)} on message ${this.current.messageId}\n${this.transcript()}`,
      );
    }
    this.lastSentAt = Date.now();
    if (action.id) {
      this.session.submitClick(this.chatId, this.user, action.id, this.current.messageId);
    } else {
      this.session.submitText(this.chatId, this.user, action.label);
    }
    return this;
  }

  /**
   * Waits for the bot's next not-yet-consumed message to this chat, up to
   * `timeoutMs` (default {@link DEFAULT_SAFETY_TIMEOUT_MS}), resolving to a
   * {@link BotMessageExpectation}. Rejects with a transcript-bearing `Error`
   * on timeout. Consumes one slot in this chat's message cursor — see the
   * module doc comment.
   */
  async expectBotMessage(opts: ExpectOptions = {}): Promise<BotMessageExpectation> {
    const timeoutMs = opts.timeoutMs ?? this.safetyTimeoutMs;
    const journal = this.session.journal(this.chatId);
    const consumedAtStart = this.consumed;

    const entry = await waitForCondition(
      journal,
      () => nthOutboundMessage(journal.entries(), consumedAtStart),
      timeoutMs,
      () =>
        new Error(
          `chatwright: expected a bot message within ${timeoutMs}ms (safety timeout), but none arrived\n${this.transcript()}`,
        ),
    );

    this.consumed += 1;
    return this.finalize(entry);
  }

  /**
   * Waits for `ref` (typically a previously resolved
   * {@link BotMessageExpectation}, or a bare `{messageId, version}`) to be
   * edited in place — `version` strictly greater than `ref.version` — up to
   * `timeoutMs` (default {@link DEFAULT_SAFETY_TIMEOUT_MS}), resolving to a
   * {@link BotMessageExpectation} for its new content. Rejects with a
   * transcript-bearing `Error` on timeout. Does **not** advance this chat's
   * message cursor.
   */
  async expectEdited(ref: MessageRef, opts: ExpectOptions = {}): Promise<BotMessageExpectation> {
    const timeoutMs = opts.timeoutMs ?? this.safetyTimeoutMs;
    const journal = this.session.journal(this.chatId);
    const { messageId, version: afterVersion } = ref;

    const entry = await waitForCondition(
      journal,
      () => {
        const latest = latestEntryForMessage(journal.entries(), messageId);
        return latest && latest.version > afterVersion ? latest : undefined;
      },
      timeoutMs,
      () =>
        new Error(
          `chatwright: expected message ${messageId} to be edited within ${timeoutMs}ms (safety timeout), but it was not\n${this.transcript()}`,
        ),
    );

    return this.finalize(entry);
  }

  /** Renders this chat's transcript so far — the same text embedded in this chat's assertion failures. */
  transcript(): string {
    return renderTranscript(this.chatId, this.session.journal(this.chatId).entries());
  }

  private finalize(entry: JournalEntry): BotMessageExpectation {
    const latencyMs = Math.max(0, Date.now() - this.lastSentAt);
    this.current = { messageId: entry.messageId, actions: entry.actions ?? [] };
    return new BotMessageExpectation(this, entry, latencyMs);
  }
}

function findAction(
  rows: readonly (readonly JournalAction[])[],
  idOrLabel: string,
): JournalAction | undefined {
  for (const row of rows) {
    for (const action of row) {
      if (action.id === idOrLabel || action.label === idOrLabel) return action;
    }
  }
  return undefined;
}

const registry = new WeakMap<Session, Map<number, Chat>>();

/**
 * Returns a {@link Chat} handle for `chatId` on `session`. Calling it again
 * for the same `(session, chatId)` pair returns the same handle, not a
 * fresh one — the consumption cursor and latency baseline are shared across
 * every call site that addresses that chat, mirroring Go's `PrivateChat`
 * aliasing (`chatwright/runtime-go/cw/chat.go`). `user` and `opts` are only
 * honored the first time a given `(session, chatId)` pair is requested;
 * later calls ignore them and return the existing handle, exactly as Go's
 * `PrivateChat` ignores everything but identity on a cache hit.
 */
export function chatOf(session: Session, chatId: number, user: TelegramUser, opts: ChatOfOptions = {}): Chat {
  let chats = registry.get(session);
  if (!chats) {
    chats = new Map();
    registry.set(session, chats);
  }
  let chat = chats.get(chatId);
  if (!chat) {
    chat = new Chat(session, chatId, user, opts.safetyTimeoutMs ?? DEFAULT_SAFETY_TIMEOUT_MS);
    chats.set(chatId, chat);
  }
  return chat;
}

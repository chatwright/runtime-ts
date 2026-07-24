/**
 * `TelegramCodec` — the Telegram platform codec: builds Telegram Bot API
 * `Update` objects for user-originated events and parses/answers the bot's
 * outbound Bot API method calls, journalling every event exactly as
 * {@link https://github.com/chatwright/runtime-go/blob/main/telegram/emulator.go | runtime-go's telegram.Emulator}
 * does — this is the TypeScript runtime's first codec, ported as an
 * algorithm (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}),
 * not shared as code.
 *
 * @remarks
 * **What this slice covers**, matching this package's README fidelity list
 * and `docs/architecture.md`:
 *
 * - Building `message` updates ({@link TelegramCodec.buildTextUpdate}) and
 *   `callback_query` updates ({@link TelegramCodec.buildCallbackUpdate}) for
 *   user-originated events, journalling the inbound entry exactly as
 *   `Emulator.SubmitText`/`SubmitClick` do.
 * - Parsing the bot's calls ({@link TelegramCodec.handleCall}): `sendMessage`
 *   and `editMessageText` (including `reply_markup` inline keyboards),
 *   `answerCallbackQuery` (acknowledged, no journal entry — it produces no
 *   observable chat content) and `getMe`.
 * - Every other method returns the Telegram-shaped `501` error
 *   (`{"ok":false,"error_code":501,"description":"method not emulated: X"}`)
 *   and journals an `"uncaptured"` entry — the same honesty rule as
 *   `Emulator.handleUnsupported`: an unrecognised call is surfaced, never
 *   silently swallowed.
 *
 * **Deliberate narrowing versus runtime-go**, recorded in
 * `docs/architecture.md` and the cross-repo parity register
 * (`docs/runtime-parity.md`, decision 0015): runtime-go's emulator also
 * acknowledges `setWebhook`, `deleteWebhook` and `setMyCommands` as silent
 * no-ops, because a real Telegram bot library often calls them
 * unconditionally on startup regardless of delivery mode. The iframe
 * transport has no webhook concept at all — updates arrive over a
 * `MessagePort`, never a webhook — so this codec does not special-case
 * those three; a bot that calls them sees the same honest `501` as any
 * other unemulated method. `answerCallbackQuery` is kept acknowledged
 * because it is delivery-mode-independent (it only stops a client's loading
 * spinner) and is exercised directly by this slice's inline-keyboard flow.
 *
 * State this codec owns: a per-chat message-id sequence and one
 * emulator-wide update-id sequence, mirroring `Emulator.nextMsgID` /
 * `Emulator.nextUpdateID` exactly (message ids are per chat; update ids are
 * global). It does **not** own journal storage — the caller (see {@link
 * "../session/session.js".Session}) supplies the {@link
 * "../journal/journal.js".Journal} for whichever chat a call or event
 * concerns, mirroring how `Emulator` resolves a chat's journal view from a
 * flat store keyed on the same `chat_id` a real Bot API call carries.
 */

import type { Journal, JournalAction, JournalEntry } from "../journal/journal.js";
import type { Clock } from "../journal/in-memory-journal.js";
import { systemClock } from "../journal/in-memory-journal.js";
import type { PlatformCodec } from "../platform/codec.js";

/** The Telegram user id this codec always assigns to the emulated bot. */
export const TELEGRAM_BOT_USER_ID = 1;
/** The fixed display name `getMe` and every bot-originated message report. */
export const TELEGRAM_BOT_FIRST_NAME = "ChatwrightBot";
/** The fixed username `getMe` reports. */
export const TELEGRAM_BOT_USERNAME = "chatwright_bot";
const BOT_FIRST_NAME = TELEGRAM_BOT_FIRST_NAME;
const BOT_USERNAME = TELEGRAM_BOT_USERNAME;

/** A neutral participant identity, mirroring runtime-go's `platform.User`. */
export interface TelegramUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
}

// ---- Telegram Bot API wire shapes (the subset this slice emulates) -------

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface TelegramChat {
  readonly id: number;
  readonly type: "private";
  readonly first_name?: string;
}

export interface TelegramWireUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from: TelegramWireUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text: string;
  readonly reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramWireUser;
  readonly message: TelegramMessage;
  readonly data: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramOkResult<T = unknown> {
  readonly ok: true;
  readonly result: T;
}

export interface TelegramErrorResult {
  readonly ok: false;
  readonly error_code: number;
  readonly description: string;
}

export type TelegramResult<T = unknown> = TelegramOkResult<T> | TelegramErrorResult;

/** What {@link TelegramCodec.handleCall} needs from its caller: journal access, resolved per chat. */
export interface TelegramCallContext {
  /** Returns (creating if necessary) the journal for a given chat id. */
  readonly journalFor: (chatId: number) => Journal;
}

/**
 * The Telegram platform codec. See the module doc comment for scope and the
 * deliberate deviations from runtime-go's `telegram.Emulator`.
 */
export class TelegramCodec implements PlatformCodec {
  readonly platform = "telegram";
  readonly capabilities = ["messaging.buttons.inline", "messaging.message.edit"] as const;
  /** This codec's own identity for a run-bundle actor's `platformIdentities` entry — see {@link "../platform/codec.js".PlatformCodec.botIdentity}. */
  readonly botIdentity = { userId: TELEGRAM_BOT_USER_ID, firstName: TELEGRAM_BOT_FIRST_NAME };

  private readonly clock: Clock;
  private readonly nextMessageId = new Map<number, number>();
  private nextUpdateIdValue = 0;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  // ---- Building updates (user-originated events) --------------------------

  /**
   * Builds a `message` update for a user's submitted text, journalling the
   * inbound entry — mirrors `Emulator.SubmitText`.
   */
  buildTextUpdate(chatId: number, user: TelegramUser, text: string, journal: Journal): TelegramUpdate {
    const messageId = this.reserveMessageId(chatId);
    const at = this.clock();
    journal.append({
      direction: "user",
      kind: "message",
      messageId,
      refMessageId: 0,
      version: 0,
      text,
      method: "",
      at: at.toISOString(),
      fromId: user.id,
    });

    return {
      update_id: this.reserveUpdateId(),
      message: {
        message_id: messageId,
        from: toWireUser(user, false),
        chat: { id: chatId, type: "private", first_name: user.firstName },
        date: unixSeconds(at),
        text,
      },
    };
  }

  /**
   * Builds a `callback_query` update for a user clicking an inline-keyboard
   * action, journalling the inbound entry — mirrors `Emulator.SubmitClick`.
   * A callback query does not reserve a message id of its own; `actionId` is
   * the clicked action's stable id (Telegram's `callback_data`).
   */
  buildCallbackUpdate(
    chatId: number,
    user: TelegramUser,
    targetMessageId: number,
    actionId: string,
    journal: Journal,
  ): TelegramUpdate {
    const at = this.clock();
    journal.append({
      direction: "user",
      kind: "action",
      messageId: 0,
      refMessageId: targetMessageId,
      version: 0,
      text: actionId,
      method: "",
      at: at.toISOString(),
      fromId: user.id,
    });

    const updateId = this.reserveUpdateId();
    return {
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        from: toWireUser(user, false),
        data: actionId,
        message: {
          message_id: targetMessageId,
          from: toWireUser({ id: TELEGRAM_BOT_USER_ID, firstName: BOT_FIRST_NAME }, true),
          chat: { id: chatId, type: "private", first_name: user.firstName },
          date: 0,
          text: "",
        },
      },
    };
  }

  // ---- Handling calls (bot-originated) ------------------------------------

  /**
   * Parses and answers one Bot API method call. See the module doc comment
   * for exactly which methods are emulated; everything else returns the
   * Telegram-shaped `501` and journals an `"uncaptured"` entry.
   */
  handleCall(method: string, params: unknown, ctx: TelegramCallContext): TelegramResult {
    switch (method) {
      case "getMe":
        return this.handleGetMe();
      case "sendMessage":
        return this.handleSendMessage(params, ctx);
      case "editMessageText":
        return this.handleEditMessageText(params, ctx);
      case "answerCallbackQuery":
        // Acknowledged, no-op: stops the client's loading spinner, produces
        // no observable chat content — matches Emulator's acknowledgedMethods.
        return { ok: true, result: true };
      default:
        return this.handleUnsupported(method, params, ctx);
    }
  }

  private handleGetMe(): TelegramResult<TelegramWireUser> {
    return {
      ok: true,
      result: { id: TELEGRAM_BOT_USER_ID, is_bot: true, first_name: BOT_FIRST_NAME, username: BOT_USERNAME },
    };
  }

  private handleSendMessage(params: unknown, ctx: TelegramCallContext): TelegramResult {
    const p = asRecord(params);
    const chatId = toChatId(p?.chat_id);
    const text = typeof p?.text === "string" ? p.text : "";
    const markup = asInlineKeyboardMarkup(p?.reply_markup);

    if (chatId === undefined) return errorResult(400, "sendMessage: chat_id is required");
    if (!text) return errorResult(400, "sendMessage: text is required");

    const journal = ctx.journalFor(chatId);
    const messageId = this.reserveMessageId(chatId);
    const at = this.clock();
    journal.append({
      direction: "bot",
      kind: "message",
      messageId,
      refMessageId: 0,
      version: 0,
      text,
      actions: actionsFromMarkup(markup),
      method: "sendMessage",
      at: at.toISOString(),
      fromId: TELEGRAM_BOT_USER_ID,
    });

    return {
      ok: true,
      result: {
        message_id: messageId,
        from: toWireUser({ id: TELEGRAM_BOT_USER_ID, firstName: BOT_FIRST_NAME }, true),
        chat: { id: chatId, type: "private" },
        date: unixSeconds(at),
        text,
        ...(markup ? { reply_markup: markup } : {}),
      },
    };
  }

  private handleEditMessageText(params: unknown, ctx: TelegramCallContext): TelegramResult {
    const p = asRecord(params);
    const chatId = toChatId(p?.chat_id);
    const messageId = typeof p?.message_id === "number" ? p.message_id : undefined;
    const text = typeof p?.text === "string" ? p.text : "";
    const markup = asInlineKeyboardMarkup(p?.reply_markup);

    if (chatId === undefined || messageId === undefined) {
      return errorResult(400, "editMessageText: chat_id and message_id are required");
    }

    const journal = ctx.journalFor(chatId);
    const prev = latestBotTextEntry(journal, messageId);
    if (!prev) return errorResult(400, "message to edit not found");

    // editMessageText without reply_markup REMOVES the existing keyboard —
    // real Telegram only keeps a message's inline keyboard when the edit
    // call explicitly re-sends reply_markup; omitting it clears the keyboard
    // (decision 0015, cross-repo parity register docs/runtime-parity.md).
    const actions = markup ? actionsFromMarkup(markup) : undefined;
    const version = prev.version + 1;
    const at = this.clock();
    journal.append({
      direction: "bot",
      kind: "message",
      messageId,
      refMessageId: 0,
      version,
      text,
      actions,
      method: "editMessageText",
      at: at.toISOString(),
      fromId: TELEGRAM_BOT_USER_ID,
    });

    return {
      ok: true,
      result: {
        message_id: messageId,
        from: toWireUser({ id: TELEGRAM_BOT_USER_ID, firstName: BOT_FIRST_NAME }, true),
        chat: { id: chatId, type: "private" },
        date: unixSeconds(at),
        text,
      },
    };
  }

  private handleUnsupported(method: string, params: unknown, ctx: TelegramCallContext): TelegramResult {
    const p = asRecord(params);
    const chatId = toChatId(p?.chat_id) ?? 0; // best-effort attribution, matching Emulator.handleUnsupported
    const journal = ctx.journalFor(chatId);
    journal.append({
      direction: "bot",
      kind: "uncaptured",
      messageId: 0,
      refMessageId: 0,
      version: 0,
      text: "",
      method,
      at: this.clock().toISOString(),
      fromId: TELEGRAM_BOT_USER_ID,
    });
    return errorResult(501, `method not emulated: ${method}`);
  }

  private reserveMessageId(chatId: number): number {
    const next = (this.nextMessageId.get(chatId) ?? 0) + 1;
    this.nextMessageId.set(chatId, next);
    return next;
  }

  private reserveUpdateId(): number {
    this.nextUpdateIdValue += 1;
    return this.nextUpdateIdValue;
  }
}

// ---- helpers ---------------------------------------------------------------

function latestBotTextEntry(journal: Journal, messageId: number): JournalEntry | undefined {
  const entries = journal.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.direction === "bot" && entry.kind === "message" && entry.messageId === messageId) {
      return entry;
    }
  }
  return undefined;
}

function actionsFromMarkup(
  markup: TelegramInlineKeyboardMarkup | undefined,
): readonly (readonly JournalAction[])[] | undefined {
  if (!markup) return undefined;
  return markup.inline_keyboard.map((row) =>
    row.map((button) => ({ label: button.text, id: button.callback_data ?? "", url: button.url ?? "" })),
  );
}

function toWireUser(user: TelegramUser, isBot: boolean): TelegramWireUser {
  return {
    id: user.id,
    is_bot: isBot,
    first_name: user.firstName,
    ...(user.lastName !== undefined ? { last_name: user.lastName } : {}),
    ...(user.username !== undefined ? { username: user.username } : {}),
  };
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Parses a Bot API `chat_id` (number or numeric string); `0`/missing is treated as absent, matching Emulator. */
function toChatId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw !== 0) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed !== 0) return parsed;
  }
  return undefined;
}

function asInlineKeyboardMarkup(raw: unknown): TelegramInlineKeyboardMarkup | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as { inline_keyboard?: unknown };
  if (!Array.isArray(candidate.inline_keyboard)) return undefined;
  return { inline_keyboard: candidate.inline_keyboard as TelegramInlineKeyboardMarkup["inline_keyboard"] };
}

function errorResult(errorCode: number, description: string): TelegramErrorResult {
  return { ok: false, error_code: errorCode, description };
}

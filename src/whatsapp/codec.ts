/**
 * `WhatsAppCodec` — the WhatsApp platform codec: builds WhatsApp Cloud API
 * (Graph API) inbound webhook payloads for user-originated events and
 * parses/answers the bot's outbound send-message calls, journalling every
 * event exactly as
 * {@link https://github.com/chatwright/runtime-go/blob/main/whatsapp/emulator.go | runtime-go's whatsapp.Emulator}
 * does — the runtime's second codec, ported as an algorithm (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}),
 * never as shared code, following the seam {@link
 * "../platform/codec.js".PlatformCodec} states and {@link
 * "../telegram/codec.js".TelegramCodec} first proved out.
 *
 * @remarks
 * **What this slice covers**, matching this package's README fidelity list
 * and `docs/architecture.md` — deliberately the same narrow, text-first MVP
 * slice `runtime-go`'s `whatsapp.Emulator` covers (its package doc: "This is
 * the MVP-scope, text-first WhatsApp platform"), per the parity rule
 * (decision 0015, development principle 7 — a feature ships in both
 * runtimes with identical semantics, or the gap is recorded, never silent):
 *
 * - Building a `messages` webhook update ({@link
 *   WhatsAppCodec.buildTextUpdate}) for a user's submitted text, journalling
 *   the inbound entry exactly as `Emulator.SubmitText` does.
 * - Parsing the bot's one supported outbound call ({@link
 *   WhatsAppCodec.handleCall}): a `"sendMessage"` call whose params carry
 *   `type: "text"` — mirroring the `wabotapi` Go client's own
 *   `Client.SendMessage`/`SendTextConfig` shape, the same wire shape
 *   `runtime-go`'s emulator decodes bot calls into.
 * - Every other call — a `type` other than `"text"` (image, interactive,
 *   template, …) or a `method` other than `"sendMessage"` — returns the
 *   WhatsApp Cloud API's own `{"error": {...}}` envelope shape and journals
 *   an `"uncaptured"` entry: the same honesty rule `TelegramCodec` follows
 *   for its own unemulated methods, and the same rule decision 0008 names
 *   ("fidelity is declared, never assumed").
 *
 * **No interactive actions, no edits — a deliberate narrowing recorded
 * here, in the README's fidelity table and in the cross-repo parity
 * register (`docs/runtime-parity.md`, decision 0015), never silently
 * absorbed:**
 *
 * - **No `buildCallbackUpdate`.** `runtime-go`'s `Emulator` does implement
 *   `SubmitClick` (an inbound interactive-reply click), but this slice's
 *   `capabilities` — `["messaging.text"]` — declares no interactive-action
 *   support, so this codec omits `buildCallbackUpdate` entirely (the {@link
 *   "../platform/codec.js".PlatformCodec} seam makes it optional for
 *   exactly this reason) rather than shipping a stub that would misrepresent
 *   fidelity. {@link "../session/session.js".Session.submitClick} reports an
 *   honest error for any codec, this one included, that omits it. WhatsApp
 *   itself has no free-form inline-keyboard equivalent to Telegram's
 *   `callback_data` grid — see `messaging.buttons.inline`'s capability data
 *   in `chatwright/recipes` for how narrow the real primitive (reply
 *   buttons, list messages) is versus Telegram's.
 * - **No message-edit call.** The WhatsApp Cloud API has no message-edit
 *   endpoint at all — unlike Telegram's narrowing (an iframe-transport
 *   limitation on top of a real capability), this is a real-platform
 *   absence, so there is no `editMessageText`-equivalent to even consider
 *   emulating. Every journalled message entry this codec produces therefore
 *   has `version: 0` — mirrors `runtime-go`'s own doc comment on
 *   `Emulator.Journal`: "the WhatsApp Cloud API has no message-edit
 *   endpoint … so Version is always 0".
 *
 * **One recorded strengthening versus `runtime-go`, not a narrowing —
 * documented per decision 0008 the same as any other deviation:**
 * `Emulator.handle` (the Go emulator's HTTP handler) blindly decodes *any*
 * POST to a `/messages`-suffixed path as `wabotapi.SendTextConfig` and
 * always succeeds, journalling whatever `Text.Body` happens to be — empty
 * for a non-text send, since only `SendTextConfig` populates that field.
 * Its own doc comment names this directly: "this text-first MVP-scope
 * emulator does not yet capture outbound interactive actions … Version is
 * always 0, Actions is always empty and `JournalEntryUncaptured` never
 * occurs." That is a known, accepted gap in the HTTP-transport emulator,
 * not a wire behaviour worth reproducing: this codec instead inspects the
 * call's `type` field (the same discriminator the real Cloud API itself
 * uses to route a send) and honestly reports anything other than `"text"`
 * as unsupported — error envelope plus an `"uncaptured"` journal entry —
 * rather than silently losing the call's content. Recorded here so a
 * reader diffing this codec against `emulator.go` line-for-line does not
 * mistake it for an oversight.
 *
 * **Journalled `fromId` is always `0`.** `runtime-go`'s own
 * `toPlatformEntry` never sets `platform.JournalEntry.FromID` for a
 * WhatsApp entry (inbound or outbound) — mirrored here faithfully rather
 * than "fixed" unilaterally, since principle 7 asks for identical
 * semantics, not a unilaterally improved TS runtime; see this repository's
 * task notes for a suggested `runtime-go` follow-up.
 *
 * State this codec owns: a per-chat message-id sequence, mirroring
 * `Emulator.nextMsgID` exactly (message ids are per chat, shared between
 * inbound and outbound, exactly like Telegram's — WhatsApp has no separate
 * "update id" concept at all, so unlike `TelegramCodec` there is no second,
 * emulator-wide sequence here). It does **not** own journal storage — the
 * caller (see {@link "../session/session.js".Session}) supplies the {@link
 * "../journal/journal.js".Journal} for whichever chat a call or event
 * concerns, exactly like `TelegramCodec`.
 */

import type { Journal } from "../journal/journal.js";
import type { Clock } from "../journal/in-memory-journal.js";
import { systemClock } from "../journal/in-memory-journal.js";
import type { PlatformCodec } from "../platform/codec.js";

/**
 * The numeric identity this codec assigns to the emulated WhatsApp
 * business phone number for a run-bundle actor's `platformIdentities`
 * entry (see {@link "../platform/codec.js".PlatformBotIdentity}) — the
 * integer form of {@link WHATSAPP_DISPLAY_PHONE_NUMBER}. This is a
 * TS-runtime-only bundle-assembly convenience: the WhatsApp Cloud API
 * itself has no "get my bot identity" call the way Telegram's `getMe`
 * does, and `runtime-go`'s `whatsapp` package has no bundle-assembly code
 * of its own to mirror here (unlike `TELEGRAM_BOT_USER_ID`, which
 * literally appears on the wire via Telegram's `getMe`).
 */
export const WHATSAPP_BOT_USER_ID = 15550000000;
/** The fixed display name this codec's actor identity reports. Mirrors `TELEGRAM_BOT_FIRST_NAME`'s role, not any WhatsApp wire field. */
export const WHATSAPP_BOT_FIRST_NAME = "ChatwrightBot";
/** The fixed emulated business phone number every inbound webhook's `metadata.display_phone_number` reports — literally matches `runtime-go`'s `Emulator.SubmitText`. */
export const WHATSAPP_DISPLAY_PHONE_NUMBER = "15550000000";
/** The fixed `{phone-number-id}` every inbound webhook's `metadata.phone_number_id` reports, and the path segment `BotAPIURL()`-style bots would call — literally matches `runtime-go`'s `Emulator.SubmitText`. */
export const WHATSAPP_PHONE_NUMBER_ID = "chatwright-phone";

/** A neutral participant identity, mirroring runtime-go's `platform.User` — the same shared type Telegram's `platform.User` already is in Go. Only `firstName` is read by this codec (the contact profile name); `lastName`/`username` have no WhatsApp wire equivalent, exactly like `runtime-go`'s `Emulator.SubmitText`. */
export interface WhatsAppUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
}

// ---- WhatsApp Cloud API wire shapes (the subset this slice emulates) -----

export interface WhatsAppWebhookMetadata {
  readonly display_phone_number: string;
  readonly phone_number_id: string;
}

export interface WhatsAppWebhookContactProfile {
  readonly name: string;
}

export interface WhatsAppWebhookContact {
  readonly profile: WhatsAppWebhookContactProfile;
  readonly wa_id: string;
}

export interface WhatsAppInboundText {
  readonly body: string;
}

export interface WhatsAppInboundMessage {
  readonly from: string;
  readonly id: string;
  readonly timestamp: string;
  readonly type: "text";
  readonly text: WhatsAppInboundText;
}

export interface WhatsAppInboundValue {
  readonly messaging_product: "whatsapp";
  readonly metadata: WhatsAppWebhookMetadata;
  readonly contacts?: readonly WhatsAppWebhookContact[];
  readonly messages?: readonly WhatsAppInboundMessage[];
}

export interface WhatsAppInboundChange {
  readonly field: "messages";
  readonly value: WhatsAppInboundValue;
}

export interface WhatsAppInboundEntry {
  readonly id: string;
  readonly changes: readonly WhatsAppInboundChange[];
}

/** The inbound webhook payload {@link WhatsAppCodec.buildTextUpdate} builds — mirrors `runtime-go`'s `inboundRequest`. */
export interface WhatsAppInboundRequest {
  readonly object: "whatsapp_business_account";
  readonly entry: readonly WhatsAppInboundEntry[];
}

/** The `text` object of a `sendMessage` call's params — mirrors `wabotapi.TextBody`. */
export interface WhatsAppTextBody {
  readonly body: string;
  readonly preview_url?: boolean;
}

/** Threads a reply to a prior inbound message — mirrors `wabotapi.MessageContext`. Accepted but not acted on by this slice. */
export interface WhatsAppMessageContext {
  readonly message_id: string;
}

/**
 * The params of a `"sendMessage"` call — mirrors the JSON body
 * `wabotapi.Client.SendMessage` POSTs to `{phone-number-id}/messages`
 * (`wabotapi.SendTextConfig` when `type` is `"text"`). `type` is the same
 * discriminator the real Cloud API itself switches on; only `"text"` is
 * emulated here — see the module doc comment.
 */
export interface WhatsAppSendMessageParams {
  readonly messaging_product: "whatsapp";
  readonly recipient_type?: "individual";
  readonly to: string;
  readonly type: string;
  readonly text?: WhatsAppTextBody;
  readonly context?: WhatsAppMessageContext;
}

export interface WhatsAppResponseContact {
  readonly wa_id: string;
}

export interface WhatsAppResponseMessage {
  readonly id: string;
}

/** A successful send's result — mirrors `wabotapi.SendMessageResponse` / `runtime-go`'s `Emulator.handle` success envelope exactly, down to the literal `"wamid.reply"` id. */
export interface WhatsAppSendMessageResult {
  readonly messaging_product: "whatsapp";
  readonly contacts: readonly WhatsAppResponseContact[];
  readonly messages: readonly WhatsAppResponseMessage[];
}

/** The nested error body of a failed call — mirrors `wabotapi.APIError`'s JSON shape. */
export interface WhatsAppAPIErrorBody {
  readonly message: string;
  readonly type: string;
  readonly code: number;
  readonly error_subcode: number;
  readonly fbtrace_id: string;
}

/**
 * A failed call's result. Unlike Telegram's `{"ok": false, ...}` envelope,
 * the Cloud API has no top-level "ok" flag at all: a successful call
 * returns the result object directly, and a failed one returns exactly
 * `{"error": {...}}` — mirrored here, not invented; see `wabotapi.APIError`'s
 * own doc comment for the same observation.
 */
export interface WhatsAppErrorResult {
  readonly error: WhatsAppAPIErrorBody;
}

export type WhatsAppResult = WhatsAppSendMessageResult | WhatsAppErrorResult;

/** What {@link WhatsAppCodec.handleCall} needs from its caller: journal access, resolved per chat. */
export interface WhatsAppCallContext {
  /** Returns (creating if necessary) the journal for a given chat id. */
  readonly journalFor: (chatId: number) => Journal;
}

/**
 * The WhatsApp platform codec. See the module doc comment for scope and the
 * deliberate deviations from `runtime-go`'s `whatsapp.Emulator`.
 */
export class WhatsAppCodec implements PlatformCodec {
  readonly platform = "whatsapp";
  readonly capabilities = ["messaging.text"] as const;
  /** This codec's own identity for a run-bundle actor's `platformIdentities` entry — see {@link "../platform/codec.js".PlatformCodec.botIdentity}. */
  readonly botIdentity = { userId: WHATSAPP_BOT_USER_ID, firstName: WHATSAPP_BOT_FIRST_NAME };

  private readonly clock: Clock;
  private readonly nextMessageId = new Map<number, number>();

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  // ---- Building updates (user-originated events) --------------------------

  /**
   * Builds a `messages` webhook update for a user's submitted text,
   * journalling the inbound entry — mirrors `Emulator.SubmitText`. `chatId`
   * doubles as the sender's `wa_id`, exactly like `runtime-go`: WhatsApp has
   * no separate chat-identity/user-identity split the way Telegram
   * incidentally does (a conversation *is* the customer's phone number), so
   * `user.id` is not used for wire identity at all — only `user.firstName`
   * (the contact profile name) is read, mirroring `Emulator.SubmitText`
   * exactly.
   */
  buildTextUpdate(chatId: number, user: WhatsAppUser, text: string, journal: Journal): WhatsAppInboundRequest {
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
      fromId: 0, // runtime-go's whatsapp.Emulator never sets FromID either — see the module doc comment
    });

    const waId = String(chatId);
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "chatwright",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: WHATSAPP_DISPLAY_PHONE_NUMBER,
                  phone_number_id: WHATSAPP_PHONE_NUMBER_ID,
                },
                contacts: [{ profile: { name: user.firstName }, wa_id: waId }],
                messages: [
                  {
                    from: waId,
                    id: `wamid.${messageId}`,
                    timestamp: String(unixSeconds(at)),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  // ---- Handling calls (bot-originated) ------------------------------------

  /**
   * Parses and answers one outbound call. Only `"sendMessage"` with
   * `params.type === "text"` is emulated; everything else — a different
   * `method`, or a recognised `"sendMessage"` call whose `type` is anything
   * but `"text"` (media, interactive, template, …) — returns the WhatsApp
   * Cloud API's own error envelope and journals an `"uncaptured"` entry. See
   * the module doc comment for exactly which behaviour this deliberately
   * strengthens versus `runtime-go`.
   */
  handleCall(method: string, params: unknown, ctx: WhatsAppCallContext): WhatsAppResult {
    if (method !== "sendMessage") {
      return this.handleUnsupported(method, params, ctx);
    }
    const p = asRecord(params);
    const type = typeof p?.type === "string" ? p.type : undefined;
    if (type !== "text") {
      return this.handleUnsupported(method, params, ctx, type);
    }
    return this.handleSendText(p, ctx);
  }

  private handleSendText(p: Record<string, unknown> | undefined, ctx: WhatsAppCallContext): WhatsAppSendMessageResult {
    const to = typeof p?.to === "string" ? p.to : "";
    const textBody = asRecord(p?.text);
    const body = typeof textBody?.body === "string" ? textBody.body : "";
    const chatId = toChatId(to);

    const journal = ctx.journalFor(chatId);
    const messageId = this.reserveMessageId(chatId);
    journal.append({
      direction: "bot",
      kind: "message",
      messageId,
      refMessageId: 0,
      version: 0,
      text: body,
      method: "sendMessage",
      at: this.clock().toISOString(),
      fromId: 0, // runtime-go's whatsapp.Emulator never sets FromID either — see the module doc comment
    });

    // Mirror runtime-go's Emulator.handle success envelope, including its
    // literal "wamid.reply" id: the emulator does not mint a fresh wamid
    // per reply, so neither does this codec.
    return {
      messaging_product: "whatsapp",
      contacts: [{ wa_id: to }],
      messages: [{ id: "wamid.reply" }],
    };
  }

  private handleUnsupported(
    method: string,
    params: unknown,
    ctx: WhatsAppCallContext,
    type?: string,
  ): WhatsAppErrorResult {
    const p = asRecord(params);
    const chatId = toChatId(typeof p?.to === "string" ? p.to : undefined); // best-effort attribution, matching Emulator.handleUnsupported's spirit
    const journal = ctx.journalFor(chatId);
    const label = type !== undefined ? `${method}:${type}` : method;
    journal.append({
      direction: "bot",
      kind: "uncaptured",
      messageId: 0,
      refMessageId: 0,
      version: 0,
      text: "",
      method: label,
      at: this.clock().toISOString(),
      fromId: 0,
    });
    return {
      error: {
        message: `chatwright: method not emulated: ${label}`,
        // Deliberately not a real Meta exception class: "ChatwrightNotEmulated"
        // is unmistakably chatwright's own honesty marker, exactly like
        // TelegramCodec borrowing HTTP 501 for a code the real Bot API would
        // never send — see that codec's own doc comment for the precedent.
        type: "ChatwrightNotEmulated",
        code: 501,
        error_subcode: 0,
        fbtrace_id: "chatwright",
      },
    };
  }

  private reserveMessageId(chatId: number): number {
    const next = (this.nextMessageId.get(chatId) ?? 0) + 1;
    this.nextMessageId.set(chatId, next);
    return next;
  }
}

// ---- helpers ---------------------------------------------------------------

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Parses a `to` value (a `wa_id`/phone-number string) into the numeric chat
 * id this runtime journals under. Falls back to `0` on an empty or
 * non-numeric value rather than rejecting the call — mirrors
 * `runtime-go`'s `strconv.ParseInt(cfg.To, 10, 64)`, whose error return is
 * discarded, defaulting `chatID` to `0` the same way.
 */
function toChatId(to: string | undefined): number {
  if (!to) return 0;
  const parsed = Number(to);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Test-only support: a reactive, in-process greetbot — the bot-under-test for
 * the greetbot scenario end-to-end proof. A synchronous
 * {@link "../transport/transport.js".BotTransport} (the same seam
 * {@link "../session/session.js".Session.registerBot} consumes), so the whole
 * scenario runs zero-network, with the bot reacting to each delivered update
 * before control returns — mirroring the Go runtime's synchronous webhook
 * delivery.
 *
 * @remarks
 * A faithful port of the Go `examples/greetbot` behaviour: `/start` offers a
 * language choice; picking one edits that same message in place, translating
 * it, and is remembered for the rest of the chat; any other text replies with
 * the current greeting. Not part of the public API — not re-exported from
 * `index.ts`. (The iframe {@link "./fake-bot.js".FakeBot} exercises the
 * postMessage handshake; this fake instead reacts to platform updates.)
 */

import type { BotCall, BotTransport } from "../transport/transport.js";
import type { TelegramUpdate, TelegramResult, TelegramInlineKeyboardMarkup } from "../telegram/codec.js";

const LANG_PREFIX = "lang:";
const LANGUAGES: { readonly code: string; readonly label: string; readonly greeting: string }[] = [
  { code: "en", label: "English", greeting: "Howdy stranger" },
  { code: "es", label: "Español", greeting: "¡Hola, forastero!" },
  { code: "fr", label: "Français", greeting: "Salut l'inconnu" },
];

function greetingFor(code: string): string {
  return (LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]!).greeting;
}

function languageKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: LANGUAGES.map((l) => [{ text: l.label, callback_data: `${LANG_PREFIX}${l.code}` }]),
  };
}

/** A minimal, real greetbot with per-chat language state, driven synchronously over a {@link BotTransport}. */
export class GreetbotBot implements BotTransport {
  #handler: ((call: BotCall) => void) | undefined;
  readonly #results = new Map<string, unknown>();
  #callSeq = 0;
  readonly #language = new Map<number, string>();

  onCall(handler: (call: BotCall) => void): void {
    this.#handler = handler;
  }

  respond(id: string, result: unknown): void {
    this.#results.set(id, result);
  }

  deliverUpdate(update: unknown): void {
    const u = update as TelegramUpdate;
    if (u.message !== undefined) {
      this.#onMessage(u.message.chat.id, u.message.text);
    } else if (u.callback_query !== undefined) {
      this.#onCallback(u.callback_query.message.chat.id, u.callback_query.message.message_id, u.callback_query.id, u.callback_query.data);
    }
  }

  close(): void {
    this.#handler = undefined;
  }

  #onMessage(chatId: number, text: string): void {
    if (text === "/start") {
      this.#call("sendMessage", { chat_id: chatId, text: "Choose your language", reply_markup: languageKeyboard() });
      return;
    }
    this.#call("sendMessage", { chat_id: chatId, text: greetingFor(this.#language.get(chatId) ?? "en") });
  }

  #onCallback(chatId: number, messageId: number, callbackId: string, data: string): void {
    if (data.startsWith(LANG_PREFIX)) {
      const code = data.slice(LANG_PREFIX.length);
      this.#language.set(chatId, code);
      this.#call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: greetingFor(code),
        reply_markup: languageKeyboard(),
      });
    }
    this.#call("answerCallbackQuery", { callback_query_id: callbackId });
  }

  /** Issues one Bot API call synchronously through the registered session handler and returns its result. */
  #call(method: string, params: unknown): TelegramResult {
    if (this.#handler === undefined) throw new Error("GreetbotBot: not registered with a session yet");
    const id = `greetbot-${++this.#callSeq}`;
    this.#handler({ id, method, payload: params });
    const result = this.#results.get(id) as TelegramResult;
    this.#results.delete(id);
    return result;
  }
}

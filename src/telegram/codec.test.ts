import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "../journal/in-memory-journal.js";
import { TELEGRAM_BOT_USER_ID, TelegramCodec, type TelegramCallContext } from "./codec.js";

function fixedClock(iso: string) {
  const date = new Date(iso);
  return () => date;
}

function contextFor(journal: InMemoryJournal): TelegramCallContext {
  return { journalFor: () => journal };
}

describe("TelegramCodec.buildTextUpdate / buildCallbackUpdate", () => {
  it("journals an inbound message and builds a Telegram message update", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:00.000Z"));
    const journal = new InMemoryJournal();

    const update = codec.buildTextUpdate(42, { id: 7, firstName: "Explorer" }, "/start", journal);

    expect(update.message?.text).toBe("/start");
    expect(update.message?.chat.id).toBe(42);
    expect(update.message?.message_id).toBe(1);

    expect(journal.entries()).toEqual([
      {
        direction: "user",
        kind: "message",
        messageId: 1,
        refMessageId: 0,
        version: 0,
        text: "/start",
        method: "",
        at: "2026-07-23T10:00:00.000Z",
        fromId: 7,
      },
    ]);
  });

  it("journals an inbound action and builds a callback_query update", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:00.000Z"));
    const journal = new InMemoryJournal();

    const update = codec.buildCallbackUpdate(42, { id: 7, firstName: "Explorer" }, 2, "lang:en", journal);

    expect(update.callback_query?.data).toBe("lang:en");
    expect(update.callback_query?.message.message_id).toBe(2);

    const [entry] = journal.entries();
    expect(entry).toMatchObject({
      direction: "user",
      kind: "action",
      messageId: 0,
      refMessageId: 2,
      text: "lang:en",
      fromId: 7,
    });
  });
});

describe("TelegramCodec.handleCall: sendMessage", () => {
  it("journals a bot message with actions from an inline keyboard", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();

    const result = codec.handleCall(
      "sendMessage",
      {
        chat_id: 42,
        text: "Choose your language",
        reply_markup: {
          inline_keyboard: [
            [{ text: "English", callback_data: "lang:en" }],
            [{ text: "Español", callback_data: "lang:es" }],
          ],
        },
      },
      contextFor(journal),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ message_id: 1, text: "Choose your language" });
    }

    expect(journal.entries()).toEqual([
      {
        direction: "bot",
        kind: "message",
        messageId: 1,
        refMessageId: 0,
        version: 0,
        text: "Choose your language",
        actions: [
          [{ label: "English", id: "lang:en", url: "" }],
          [{ label: "Español", id: "lang:es", url: "" }],
        ],
        method: "sendMessage",
        at: "2026-07-23T10:00:01.000Z",
        fromId: TELEGRAM_BOT_USER_ID,
      },
    ]);
  });

  it("rejects a call missing chat_id or text with a Telegram-shaped 400", () => {
    const codec = new TelegramCodec();
    const journal = new InMemoryJournal();

    const missingChat = codec.handleCall("sendMessage", { text: "hi" }, contextFor(journal));
    expect(missingChat).toEqual({ ok: false, error_code: 400, description: "sendMessage: chat_id is required" });

    const missingText = codec.handleCall("sendMessage", { chat_id: 42 }, contextFor(journal));
    expect(missingText).toEqual({ ok: false, error_code: 400, description: "sendMessage: text is required" });

    expect(journal.entries()).toHaveLength(0);
  });
});

describe("TelegramCodec.handleCall: editMessageText", () => {
  it("appends a new, versioned entry instead of mutating the original", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();

    codec.handleCall(
      "sendMessage",
      {
        chat_id: 42,
        text: "Choose your language",
        reply_markup: { inline_keyboard: [[{ text: "English", callback_data: "lang:en" }]] },
      },
      contextFor(journal),
    );

    const result = codec.handleCall(
      "editMessageText",
      { chat_id: 42, message_id: 1, text: "Howdy stranger" },
      contextFor(journal),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ message_id: 1, text: "Howdy stranger" });
    }

    const entries = journal.entries();
    expect(entries).toHaveLength(2); // append-only: the original entry is never mutated
    expect(entries[0]?.text).toBe("Choose your language");
    expect(entries[0]?.version).toBe(0);

    const edited = entries[1];
    expect(edited?.text).toBe("Howdy stranger");
    expect(edited?.version).toBe(1); // version bumped
    expect(edited?.method).toBe("editMessageText");
    // reply_markup omitted on the edit: the existing keyboard is kept.
    expect(edited?.actions).toEqual([[{ label: "English", id: "lang:en", url: "" }]]);
  });

  it("reports a Telegram-shaped 400 when the target message does not exist", () => {
    const codec = new TelegramCodec();
    const journal = new InMemoryJournal();

    const result = codec.handleCall(
      "editMessageText",
      { chat_id: 42, message_id: 99, text: "nope" },
      contextFor(journal),
    );

    expect(result).toEqual({ ok: false, error_code: 400, description: "message to edit not found" });
  });
});

describe("TelegramCodec.handleCall: answerCallbackQuery and getMe", () => {
  it("acknowledges answerCallbackQuery with no journal entry", () => {
    const codec = new TelegramCodec();
    const journal = new InMemoryJournal();

    const result = codec.handleCall("answerCallbackQuery", { callback_query_id: "cb1" }, contextFor(journal));

    expect(result).toEqual({ ok: true, result: true });
    expect(journal.entries()).toHaveLength(0);
  });

  it("reports the fixed emulated bot identity for getMe", () => {
    const codec = new TelegramCodec();
    const journal = new InMemoryJournal();

    const result = codec.handleCall("getMe", {}, contextFor(journal));

    expect(result).toEqual({
      ok: true,
      result: { id: TELEGRAM_BOT_USER_ID, is_bot: true, first_name: "ChatwrightBot", username: "chatwright_bot" },
    });
  });
});

describe("TelegramCodec.handleCall: unemulated methods", () => {
  it("returns the Telegram 501 wire shape and journals an uncaptured entry", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:02.000Z"));
    const journal = new InMemoryJournal();

    const result = codec.handleCall("sendPhoto", { chat_id: 42, photo: "file-id" }, contextFor(journal));

    expect(result).toEqual({ ok: false, error_code: 501, description: "method not emulated: sendPhoto" });
    expect(journal.entries()).toEqual([
      {
        direction: "bot",
        kind: "uncaptured",
        messageId: 0,
        refMessageId: 0,
        version: 0,
        text: "",
        method: "sendPhoto",
        at: "2026-07-23T10:00:02.000Z",
        fromId: TELEGRAM_BOT_USER_ID,
      },
    ]);
  });

  it("treats setWebhook as unemulated on this transport (deliberate narrowing vs. runtime-go)", () => {
    const codec = new TelegramCodec();
    const journal = new InMemoryJournal();

    const result = codec.handleCall("setWebhook", { url: "https://example.com" }, contextFor(journal));

    expect(result).toEqual({ ok: false, error_code: 501, description: "method not emulated: setWebhook" });
  });
});

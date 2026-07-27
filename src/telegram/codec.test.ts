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

  it("includes the user's language_code in message, callback, and inline-query updates", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:00.000Z"));
    const journal = new InMemoryJournal();
    const user = { id: 7, firstName: "Алиса", username: "alisa", languageCode: "ru" };

    const message = codec.buildTextUpdate(42, user, "/pref", journal);
    const callback = codec.buildCallbackUpdate(42, user, 1, "pref?a=players", journal);
    const inline = codec.buildInlineQueryUpdate(user, "preferans:invite:game-42", "");

    expect(message.message?.from.language_code).toBe("ru");
    expect(callback.callback_query?.from.language_code).toBe("ru");
    expect(inline.update.inline_query?.from.language_code).toBe("ru");
  });

  it("builds an inline_query update and captures a photo answer", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:00.000Z"));
    const journal = new InMemoryJournal();
    const built = codec.buildInlineQueryUpdate(
      { id: 7, firstName: "Alice", username: "alice" },
      "preferans:invite:game-42",
      "",
    );
    expect(built.queryId).toBe("iq1");
    expect(built.update.inline_query).toMatchObject({
      id: "iq1",
      query: "preferans:invite:game-42",
      offset: "",
      from: { id: 7, first_name: "Alice", username: "alice" },
    });

    let captured: unknown;
    const answer = codec.handleCall(
      "answerInlineQuery",
      {
        inline_query_id: built.queryId,
        is_personal: true,
        results: [{
          type: "photo",
          id: "invite-42",
          title: "Join Alice's Preferans table",
          photo_url: "https://sneat.games/preferans-invite.jpg",
          thumbnail_url: "https://sneat.games/preferans-invite-thumb.jpg",
          caption: "Alice invited you · 🪙 50 · ⏱ 60 seconds",
          reply_markup: {
            inline_keyboard: [[
              { text: "🃏 Join table", url: "https://t.me/SneatBot?start=pref_42" },
            ]],
          },
        }],
      },
      {
        journalFor: () => journal,
        captureInlineAnswer: (value) => { captured = value; },
      },
    );

    expect(answer).toEqual({ ok: true, result: true });
    expect(captured).toEqual({
      queryId: "iq1",
      isPersonal: true,
      results: [{
        type: "photo",
        id: "invite-42",
        title: "Join Alice's Preferans table",
        photoUrl: "https://sneat.games/preferans-invite.jpg",
        thumbnailUrl: "https://sneat.games/preferans-invite-thumb.jpg",
        caption: "Alice invited you · 🪙 50 · ⏱ 60 seconds",
        actions: [[{
          label: "🃏 Join table",
          id: "",
          url: "https://t.me/SneatBot?start=pref_42",
        }]],
      }],
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

  it("normalizes a switch_inline_query_chosen_chat button as an inline-share action", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();

    codec.handleCall(
      "sendMessage",
      {
        chat_id: 42,
        text: "Invite a friend",
        reply_markup: {
          inline_keyboard: [[{
            text: "📨 Choose friend",
            switch_inline_query_chosen_chat: {
              query: "preferans:invite:game-42",
              allow_user_chats: true,
            },
          }]],
        },
      },
      contextFor(journal),
    );

    expect(journal.entries()[0]?.actions).toEqual([[
      {
        label: "📨 Choose friend",
        id: "",
        url: "",
        opensInlineQuery: true,
        inlineQuery: "preferans:invite:game-42",
      },
    ]]);
  });
});

describe("TelegramCodec.handleCall: native rich messages", () => {
  it("projects rich blocks and copy-text buttons into the neutral journal", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();

    const result = codec.handleCall(
      "sendRichMessage",
      {
        chat_id: 42,
        rich_message: {
          blocks: [
            { type: "heading", text: "🃏 Preferans" },
            {
              type: "table",
              caption: "Confirmed wallet settlement",
              cells: [
                [{ text: "Player" }, { text: "Score" }],
                [{ text: "Alice" }, { text: "10" }],
              ],
            },
            {
              type: "details",
              summary: "📖 Rules",
              blocks: [{ type: "paragraph", text: "Follow suit." }],
            },
          ],
        },
        reply_markup: {
          inline_keyboard: [
            [{ text: "📋 Copy invite", copy_text: { text: "https://t.me/SneatBot?start=pref_abc" } }],
          ],
        },
      },
      contextFor(journal),
    );

    expect(result.ok).toBe(true);
    const [entry] = journal.entries();
    expect(entry?.text).toBe(
      "🃏 Preferans\nConfirmed wallet settlement\nPlayer | Score\nAlice | 10\n📖 Rules\nFollow suit.",
    );
    expect(entry?.actions).toEqual([
      [
        {
          label: "📋 Copy invite",
          id: "",
          url: "",
          copyText: "https://t.me/SneatBot?start=pref_abc",
        },
      ],
    ]);
  });

  it("edits a persistent rich message and acknowledges temporary drafts", () => {
    const codec = new TelegramCodec(fixedClock("2026-07-23T10:00:01.000Z"));
    const journal = new InMemoryJournal();
    codec.handleCall(
      "sendRichMessage",
      { chat_id: 42, rich_message: { blocks: [{ type: "paragraph", text: "Lobby" }] } },
      contextFor(journal),
    );

    const edit = codec.handleCall(
      "editMessageText",
      {
        chat_id: 42,
        message_id: 1,
        rich_message: {
          blocks: [
            {
              type: "table",
              caption: "Confirmed wallet settlement",
              cells: [[{ text: "Alice" }, { text: "+5 🪙" }]],
            },
          ],
        },
      },
      contextFor(journal),
    );
    expect(edit.ok).toBe(true);
    expect(journal.entries()[1]?.text).toBe("Confirmed wallet settlement\nAlice | +5 🪙");

    const draft = codec.handleCall(
      "sendRichMessageDraft",
      { chat_id: 42, draft_id: 9, rich_message: { blocks: [{ type: "thinking", text: "🤖 Thinking…" }] } },
      contextFor(journal),
    );
    expect(draft).toEqual({ ok: true, result: true });
    expect(journal.entries()).toHaveLength(2);
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
    // reply_markup omitted on the edit: real Telegram removes the existing
    // keyboard in this case (it is only kept when the edit re-sends
    // reply_markup explicitly) — decision 0015, docs/runtime-parity.md.
    expect(edited?.actions).toBeUndefined();
  });

  it("uses the edit's own reply_markup when the call explicitly re-sends one", () => {
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

    codec.handleCall(
      "editMessageText",
      {
        chat_id: 42,
        message_id: 1,
        text: "Choose again",
        reply_markup: { inline_keyboard: [[{ text: "Español", callback_data: "lang:es" }]] },
      },
      contextFor(journal),
    );

    const edited = journal.entries()[1];
    expect(edited?.actions).toEqual([[{ label: "Español", id: "lang:es", url: "" }]]);
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

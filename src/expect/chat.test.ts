import { afterEach, describe, expect, it } from "vitest";

import { IframeHost } from "../protocol/iframe-host.js";
import { FakeBot, flushMacrotasks } from "../testkit/fake-bot.js";
import type { TelegramUser } from "../telegram/codec.js";
import { Session } from "../session/session.js";
import { chatOf } from "./chat.js";

/** Wires a fresh Session to a fresh IframeHost/FakeBot pair, exactly like session.test.ts's setup. */
function wire(): { session: Session; host: IframeHost; bot: FakeBot } {
  const session = new Session();
  const channel = new MessageChannel();
  const host = new IframeHost(
    { expectedOrigin: "https://bot.example", platform: "telegram" },
    { kind: "port", port: channel.port1 },
  );
  const bot = new FakeBot(channel.port2);
  session.registerBot(host);
  return { session, host, bot };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("Chat: the founder's canonical case", () => {
  it("expects exactly [Yes, No] buttons, clicks Yes, then expects the in-place edit", async () => {
    const { session, host, bot } = wire();
    cleanups.push(() => {
      host.close();
      bot.close();
    });
    bot.sendHello();
    await flushMacrotasks();

    const chatId = 42;
    const user: TelegramUser = { id: 7, firstName: "Alice" };
    const chat = chatOf(session, chatId, user);

    chat.sendText("/confirm");
    await flushMacrotasks();

    // Waiting starts (subscribe-based, no polling) before the "bot" (this
    // test, playing the bot's role manually, exactly like session.test.ts)
    // ever calls sendMessage.
    const askPromise = chat.expectBotMessage();
    bot.call("c1", "sendMessage", {
      chat_id: chatId,
      text: "Are you sure?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Yes", callback_data: "confirm:yes" }],
          [{ text: "No", callback_data: "confirm:no" }],
        ],
      },
    });
    await flushMacrotasks();
    const ask = await askPromise;

    ask.expectText("Are you sure?").expectActions("Yes", "No");

    chat.click("Yes");
    await flushMacrotasks();

    const editedPromise = chat.expectEdited(ask);
    bot.call("c2", "answerCallbackQuery", { callback_query_id: "cb1" });
    bot.call("c3", "editMessageText", { chat_id: chatId, message_id: ask.messageId, text: "Confirmed!" });
    await flushMacrotasks();
    const edited = await editedPromise;

    edited.expectText("Confirmed!");
    expect(edited.messageId).toBe(ask.messageId);
    expect(edited.version).toBe(ask.version + 1);
    // editMessageText carried no reply_markup, so the keyboard is preserved, like real Telegram.
    edited.expectActions("Yes", "No");
  });
});

describe("Chat: expectBotMessage timeout", () => {
  it("rejects with a transcript-bearing Error when no reply arrives in time", async () => {
    const { session, host, bot } = wire();
    cleanups.push(() => {
      host.close();
      bot.close();
    });
    bot.sendHello();
    await flushMacrotasks();

    const chat = chatOf(session, 1, { id: 1, firstName: "Alice" });
    chat.sendText("Hi");
    await flushMacrotasks();

    let caught: Error | undefined;
    try {
      await chat.expectBotMessage({ timeoutMs: 20 });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("safety timeout");
    expect(caught?.message).toContain("chat 1 transcript:");
    expect(caught?.message).toContain("[1 user] Hi");
  });
});

describe("Chat: within() latency budget", () => {
  it("throws once the reply has arrived if it took longer than the budget", async () => {
    const { session, host, bot } = wire();
    cleanups.push(() => {
      host.close();
      bot.close();
    });
    bot.sendHello();
    await flushMacrotasks();

    const chat = chatOf(session, 2, { id: 2, firstName: "Bob" });
    chat.sendText("Hi");
    await flushMacrotasks();

    const msgPromise = chat.expectBotMessage({ timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 60)); // simulate a slow bot
    bot.call("c1", "sendMessage", { chat_id: 2, text: "Howdy stranger" });
    await flushMacrotasks();
    const msg = await msgPromise;

    expect(() => msg.within(10)).toThrow(/budget 10ms/);
    // The reply's content was correct, just late: the failure names the actual text too.
    expect(() => msg.within(10)).toThrow(/Howdy stranger/);
    // A generous-enough budget does not throw.
    expect(() => msg.within(5000)).not.toThrow();
  });
});

describe("Chat: consumption cursor", () => {
  it("consumes this chat's bot messages once each, in order, across multiple expectBotMessage calls", async () => {
    const { session, host, bot } = wire();
    cleanups.push(() => {
      host.close();
      bot.close();
    });
    bot.sendHello();
    await flushMacrotasks();

    const chat = chatOf(session, 3, { id: 3, firstName: "Cara" });
    chat.sendText("Hi"); // reserves message id 1 in this chat
    await flushMacrotasks();

    bot.call("c1", "sendMessage", { chat_id: 3, text: "One" });
    bot.call("c2", "sendMessage", { chat_id: 3, text: "Two" });
    bot.call("c3", "sendMessage", { chat_id: 3, text: "Three" });
    await flushMacrotasks();

    const first = await chat.expectBotMessage();
    const second = await chat.expectBotMessage();
    const third = await chat.expectBotMessage();

    expect([first.text(), second.text(), third.text()]).toEqual(["One", "Two", "Three"]);
    expect([first.messageId, second.messageId, third.messageId]).toEqual([2, 3, 4]);

    // Nothing left unconsumed: a fourth call must wait and then time out.
    await expect(chat.expectBotMessage({ timeoutMs: 20 })).rejects.toThrow(/safety timeout/);
  });
});

describe("chatOf aliasing", () => {
  it("returns the same handle (shared cursor) for repeated calls with the same (session, chatId)", () => {
    const session = new Session();
    const user: TelegramUser = { id: 9, firstName: "Dee" };
    const chat1 = chatOf(session, 99, user);
    const chat2 = chatOf(session, 99, user);
    expect(chat1).toBe(chat2);
  });
});

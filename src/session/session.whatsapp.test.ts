import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { IframeHost } from "../protocol/iframe-host.js";
import { FakeBot, flushMacrotasks } from "../testkit/fake-bot.js";
import { WhatsAppCodec, type WhatsAppUser } from "../whatsapp/codec.js";
import { Session } from "./session.js";

/**
 * The WhatsApp twin of `session.test.ts`'s scripted greetbot-like exchange —
 * same DOM-free `Session` + `IframeHost` + `FakeBot` pattern, driving
 * `WhatsAppCodec` instead of the default `TelegramCodec` via
 * `SessionOptions.codec`. See `session.test.ts` for the schema-validation
 * setup this file mirrors; kept in a separate file (rather than added to
 * `session.test.ts`) so the two platforms' scenarios stay independently
 * readable.
 */

const schemaPath = fileURLToPath(new URL("./__fixtures__/run-bundle.v1.schema.json", import.meta.url));

let validateBundle: ValidateFunction;

beforeAll(() => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  validateBundle = ajv.compile(schema);
});

function fixedTickClock(startIso: string, stepMs = 1000) {
  let current = new Date(startIso).getTime();
  return () => {
    const date = new Date(current);
    current += stepMs;
    return date;
  };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("Session driving WhatsAppCodec", () => {
  it("completes the iframe handshake with platform \"whatsapp\"", async () => {
    const session = new Session({ codec: new WhatsAppCodec() });
    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://langbot.example", platform: "whatsapp" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    expect(host.connected).toBe(false);

    bot.sendHello("whatsapp", ["messaging.text"]);
    await flushMacrotasks();

    expect(host.connected).toBe(true);
    expect(bot.connected).toBe(true);
  });

  it("round-trips a plain text message end to end", async () => {
    const clock = fixedTickClock("2026-07-23T10:00:00.000Z");
    const session = new Session({ clock, codec: new WhatsAppCodec(clock) });
    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://langbot.example", platform: "whatsapp" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    bot.sendHello("whatsapp", ["messaging.text"]);
    await flushMacrotasks();

    const chatId = 15551234567;
    const user: WhatsAppUser = { id: chatId, firstName: "Explorer" };

    session.submitText(chatId, user, "hello");
    await flushMacrotasks();

    const update = bot.updates()[0];
    expect(update).toMatchObject({ platform: "whatsapp" });
    const payload = update?.payload as {
      entry: { changes: { value: { messages: { text: { body: string } }[] } }[] }[];
    };
    expect(payload.entry[0]?.changes[0]?.value.messages[0]?.text.body).toBe("hello");

    bot.call("c1", "sendMessage", {
      messaging_product: "whatsapp",
      to: String(chatId),
      type: "text",
      text: { body: "Howdy stranger" },
    });
    await flushMacrotasks();

    const result = bot.results().find((envelope) => envelope.id === "c1");
    expect(result).toMatchObject({
      platform: "whatsapp",
      payload: { messaging_product: "whatsapp", messages: [{ id: "wamid.reply" }] },
    });

    const entries = session.journal(chatId).entries();
    expect(entries).toHaveLength(2); // inbound "hello", outbound "Howdy stranger"
    expect(entries[0]).toMatchObject({ direction: "user", text: "hello" });
    expect(entries[1]).toMatchObject({ direction: "bot", text: "Howdy stranger" });
  });

  it("reports an honest error and journals an uncaptured entry for an unsupported call", async () => {
    const session = new Session({ codec: new WhatsAppCodec() });
    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://langbot.example", platform: "whatsapp" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    bot.sendHello("whatsapp", ["messaging.text"]);
    await flushMacrotasks();

    const chatId = 15551234567;
    bot.call("c1", "sendMessage", {
      messaging_product: "whatsapp",
      to: String(chatId),
      type: "interactive",
      interactive: { type: "button", body: { text: "Pick one" } },
    });
    await flushMacrotasks();

    const result = bot.results().find((envelope) => envelope.id === "c1");
    expect(result?.payload).toMatchObject({
      error: { type: "ChatwrightNotEmulated", code: 501 },
    });

    const entries = session.journal(chatId).entries();
    expect(entries).toEqual([
      {
        direction: "bot",
        kind: "uncaptured",
        messageId: 0,
        refMessageId: 0,
        version: 0,
        text: "",
        method: "sendMessage:interactive",
        at: entries[0]?.at,
        fromId: 0,
      },
    ]);
  });

  it("throws from submitClick — this codec declares no interactive-action support", () => {
    const session = new Session({ codec: new WhatsAppCodec() });
    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://langbot.example", platform: "whatsapp" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    expect(() => session.submitClick(42, { id: 7, firstName: "Explorer" }, "lang:en", 1)).toThrow(
      /declares no interactive-action support/,
    );
  });

  it("runs a full numbered-replies conversation — plain text throughout — and toBundle() validates with platform \"whatsapp\"", async () => {
    const clock = fixedTickClock("2026-07-23T10:00:00.000Z");
    const session = new Session({
      clock,
      codec: new WhatsAppCodec(clock),
      runId: "run-1",
      human: { id: "explorer", type: "scripted", name: "Explorer" },
      bot: { id: "langbot", type: "bot", name: "LangBot" },
    });

    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://langbot.example", platform: "whatsapp" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    bot.sendHello("whatsapp", ["messaging.text"]);
    await flushMacrotasks();
    expect(host.connected).toBe(true);

    const chatId = 15551234567;
    const user: WhatsAppUser = { id: chatId, firstName: "Explorer" };

    // --- Turn 1: bot offers a numbered menu, as plain text -------------------
    bot.call("c1", "sendMessage", {
      messaging_product: "whatsapp",
      to: String(chatId),
      type: "text",
      text: { body: "Choose your language: 1) English 2) Español 3) Français" },
    });
    await flushMacrotasks();

    // --- Turn 2: user replies with a bare number, as plain text --------------
    session.submitText(chatId, user, "1");
    await flushMacrotasks();

    // --- Turn 3: bot greets in the chosen language, as plain text ------------
    bot.call("c2", "sendMessage", {
      messaging_product: "whatsapp",
      to: String(chatId),
      type: "text",
      text: { body: "Howdy stranger" },
    });
    await flushMacrotasks();

    const bundle = session.toBundle() as {
      format: string;
      runs: {
        platform: string;
        chats: { chatId: number; entries: unknown[] }[];
        actors: { platformIdentities?: Record<string, unknown> }[];
      }[];
    };

    expect(bundle.format).toBe("https://chatwright.dev/formats/run-bundle/v1");
    const [run] = bundle.runs;
    expect(run?.platform).toBe("whatsapp");
    expect(run?.chats).toHaveLength(1);
    expect(run?.chats[0]?.entries).toHaveLength(3); // menu, "1", greeting — all plain text
    expect(run?.actors[0]?.platformIdentities).toEqual({ whatsapp: { userId: chatId, firstName: "Explorer" } });
    expect(run?.actors[1]?.platformIdentities).toMatchObject({ whatsapp: { userId: expect.any(Number) } });

    const valid = validateBundle(bundle);
    if (!valid) {
      throw new Error(`bundle failed schema validation: ${JSON.stringify(validateBundle.errors)}`);
    }
    expect(valid).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { IframeHost } from "../protocol/iframe-host.js";
import { FakeBot, flushMacrotasks } from "../testkit/fake-bot.js";
import type { TelegramUser } from "../telegram/codec.js";
import { Session } from "./session.js";

const schemaPath = fileURLToPath(new URL("./__fixtures__/run-bundle.v1.schema.json", import.meta.url));

/**
 * `strict: false` because this fixture's schema uses `"format": "date-time"`
 * annotations, and this package deliberately does not add the `ajv-formats`
 * dependency (the task keeps new devDependencies to vitest + ajv). Ajv's
 * strict mode otherwise throws on an unrecognised `format` keyword. A
 * hand-rolled `date-time` format (below) still checks every timestamp
 * parses, so this is not a loss of coverage — every other keyword
 * (`type`, `required`, `enum`, `additionalProperties`, …) is fully enforced
 * regardless of `strict`.
 */
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

describe("Session: a scripted greetbot-like exchange", () => {
  it("produces a run-bundle v1 document that validates against the schema", async () => {
    const clock = fixedTickClock("2026-07-23T10:00:00.000Z");
    const session = new Session({
      clock,
      runId: "run-1",
      human: { id: "explorer", type: "scripted", name: "Explorer" },
      bot: { id: "greetbot", type: "bot", name: "GreetBot" },
    });

    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: "https://greetbot.example", platform: "telegram" },
      { kind: "port", port: channel.port1 },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    session.registerBot(host);
    bot.sendHello();
    await flushMacrotasks();
    expect(host.connected).toBe(true);

    const chatId = 42;
    const user: TelegramUser = { id: 7, firstName: "Explorer" };

    // --- Turn 1: onboarding -------------------------------------------------
    session.submitText(chatId, user, "/start");
    await flushMacrotasks();

    bot.call("c1", "sendMessage", {
      chat_id: chatId,
      text: "Choose your language",
      reply_markup: {
        inline_keyboard: [
          [{ text: "English", callback_data: "lang:en" }],
          [{ text: "Español", callback_data: "lang:es" }],
          [{ text: "Français", callback_data: "lang:fr" }],
        ],
      },
    });
    await flushMacrotasks();
    const sendMessageResult = bot.results().find((envelope) => envelope.id === "c1");
    expect(sendMessageResult).toBeDefined();
    const greetingMessageId = (sendMessageResult?.payload as { result: { message_id: number } }).result.message_id;
    expect(greetingMessageId).toBe(2); // deterministic per-chat sequence: 1=/start, 2=greeting

    // --- Turn 2: user picks English, bot edits the greeting in place -------
    session.submitClick(chatId, user, "lang:en", greetingMessageId);
    await flushMacrotasks();

    bot.call("c2", "answerCallbackQuery", { callback_query_id: "cb1" });
    await flushMacrotasks();

    bot.call("c3", "editMessageText", {
      chat_id: chatId,
      message_id: greetingMessageId,
      text: "Howdy stranger",
    });
    await flushMacrotasks();
    const editResult = bot.results().find((envelope) => envelope.id === "c3");
    expect(editResult).toMatchObject({ payload: { ok: true, result: { text: "Howdy stranger" } } });

    // --- Turn 3: user acknowledges, bot replies -----------------------------
    session.submitText(chatId, user, "Thanks!");
    await flushMacrotasks();

    bot.call("c4", "sendMessage", { chat_id: chatId, text: "Howdy stranger" });
    await flushMacrotasks();

    // --- Assemble and validate ----------------------------------------------
    const bundle = session.toBundle() as {
      format: string;
      runs: { chats: { chatId: number; entries: unknown[] }[]; actors: { platformIdentities?: unknown }[] }[];
    };

    expect(bundle.format).toBe("https://chatwright.dev/formats/run-bundle/v1");
    const [run] = bundle.runs;
    expect(run?.chats).toHaveLength(1);
    expect(run?.chats[0]?.entries).toHaveLength(6); // /start, greeting, click, edit, thanks, reply
    expect(run?.actors[0]?.platformIdentities).toEqual({ telegram: { userId: 7, firstName: "Explorer" } });

    const valid = validateBundle(bundle);
    if (!valid) {
      throw new Error(`bundle failed schema validation: ${JSON.stringify(validateBundle.errors)}`);
    }
    expect(valid).toBe(true);
  });

  it("produces a valid (schema-passing) bundle even with no chats yet", () => {
    const session = new Session({ clock: fixedTickClock("2026-07-23T10:00:00.000Z") });
    const bundle = session.toBundle();
    expect(validateBundle(bundle)).toBe(true);
  });
});

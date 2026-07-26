import { afterEach, describe, expect, it } from "vitest";

import { Session } from "../session/session.js";
import type { TelegramUser } from "../telegram/codec.js";
import { HttpTransport, type HttpTransportFetch } from "./transport.js";

const chatID = 42;
const user: TelegramUser = { id: 7, firstName: "Alice" };
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("HttpTransport: Telegram inline webhook Bot API responses", () => {
  it("processes a JSON method through the same Session codec and journal path", async () => {
    const fetch = responseFetch(
      JSON.stringify({
        method: "sendMessage",
        chat_id: chatID,
        text: "🎮 Games",
        reply_markup: {
          inline_keyboard: [[{ text: "🃏 Preferans", callback_data: "pref?a=n" }]],
        },
      }),
      "application/json; charset=utf-8",
    );
    const { session, transport } = registeredSession(fetch);

    session.submitText(chatID, user, "/games");
    await transport.waitForIdle();

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.method).toBe("POST");
    expect(fetch.requests[0]?.body).toContain('"text":"/games"');
    expect(session.journal(chatID).entries()).toMatchObject([
      { direction: "user", text: "/games" },
      {
        direction: "bot",
        text: "🎮 Games",
        actions: [[{ label: "🃏 Preferans", id: "pref?a=n" }]],
        method: "sendMessage",
      },
    ]);
  });

  it("processes a form-encoded method through the same Session codec and journal path", async () => {
    const body = new URLSearchParams({
      method: "sendMessage",
      chat_id: String(chatID),
      text: "🎮 Games",
    }).toString();
    const fetch = responseFetch(body, "application/x-www-form-urlencoded");
    const { session, transport } = registeredSession(fetch);

    session.submitText(chatID, user, "/games");
    await transport.waitForIdle();

    expect(session.journal(chatID).entries()).toMatchObject([
      { direction: "user", text: "/games" },
      { direction: "bot", text: "🎮 Games", method: "sendMessage" },
    ]);
  });

  it("surfaces Telegram rejection of an invalid inline method", async () => {
    const fetch = responseFetch(
      JSON.stringify({ method: "sendMessage", chat_id: chatID }),
      "application/json",
    );
    const { session, transport } = registeredSession(fetch);

    session.submitText(chatID, user, "/games");

    await expect(transport.waitForIdle()).rejects.toThrow(
      "inline webhook method sendMessage failed 400: sendMessage: text is required",
    );
  });
});

interface RecordingFetch extends HttpTransportFetch {
  readonly requests: { readonly method: string; readonly body: string }[];
}

function responseFetch(body: string, contentType: string): RecordingFetch {
  const requests: { method: string; body: string }[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as RecordingFetch;
  Object.defineProperty(fetch, "requests", { value: requests });
  return fetch;
}

function registeredSession(fetch: HttpTransportFetch): {
  readonly session: Session;
  readonly transport: HttpTransport;
} {
  const session = new Session();
  const transport = new HttpTransport({
    webhookURL: "https://bot.example.test/telegram-webhook",
    fetch,
  });
  cleanups.push(() => transport.close());
  session.registerBot(transport);
  return { session, transport };
}

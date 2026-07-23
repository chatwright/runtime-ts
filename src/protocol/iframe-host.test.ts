import { afterEach, describe, expect, it } from "vitest";

import { IframeHost } from "./iframe-host.js";
import { FakeBot, flushMacrotasks } from "../testkit/fake-bot.js";
import type { BotCall } from "../transport/transport.js";

const EXPECTED_ORIGIN = "https://bot.example";

function connect(): { host: IframeHost; bot: FakeBot; channel: MessageChannel } {
  const channel = new MessageChannel();
  const host = new IframeHost(
    { expectedOrigin: EXPECTED_ORIGIN, platform: "telegram" },
    { kind: "port", port: channel.port1 },
  );
  const bot = new FakeBot(channel.port2);
  return { host, bot, channel };
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("IframeHost handshake", () => {
  it("replies hello-ack with a transferred port once the bot says hello", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    expect(host.connected).toBe(false);
    expect(bot.connected).toBe(false);

    bot.sendHello();
    await flushMacrotasks();

    expect(host.connected).toBe(true);
    expect(bot.connected).toBe(true);
  });

  it("ignores a hello from an unexpected origin", async () => {
    const channel = new MessageChannel();
    const host = new IframeHost(
      { expectedOrigin: EXPECTED_ORIGIN, platform: "telegram" },
      { kind: "port", port: channel.port1, origin: "https://evil.example" },
    );
    const bot = new FakeBot(channel.port2);
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();

    expect(host.connected).toBe(false);
    expect(bot.connected).toBe(false);
  });

  it("resets the session on a repeated hello, closing the prior port", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();
    expect(host.connected).toBe(true);

    let calls: BotCall[] = [];
    host.onCall((call) => calls.push(call));

    bot.call("c1", "getMe", {});
    await flushMacrotasks();
    expect(calls).toHaveLength(1);

    // Repeated hello resets the session: the old port is closed, and the
    // pending call above will never be answerable through it again.
    bot.sendHello();
    await flushMacrotasks();
    expect(host.connected).toBe(true);
    expect(() => host.respond("c1", { ok: true, result: {} })).toThrow();

    // The new steady port still works end to end.
    calls = [];
    host.onCall((call) => calls.push(call));
    bot.call("c2", "getMe", {});
    await flushMacrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("c2");
  });
});

describe("IframeHost update queueing", () => {
  it("queues updates posted before handshake and flushes them in order once connected", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    host.deliverUpdate({ n: 1 });
    host.deliverUpdate({ n: 2 });
    host.deliverUpdate({ n: 3 });
    expect(bot.updates()).toHaveLength(0); // nothing flows before handshake

    bot.sendHello();
    await flushMacrotasks();

    const updates = bot.updates();
    expect(updates).toHaveLength(3);
    expect(updates.map((envelope) => (envelope.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it("delivers updates immediately once already connected", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();

    host.deliverUpdate({ n: 1 });
    await flushMacrotasks();
    expect(bot.updates()).toHaveLength(1);
  });
});

describe("IframeHost call/result correlation", () => {
  it("routes a call to the registered handler and returns the matching result", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();

    const received: BotCall[] = [];
    host.onCall((call) => {
      received.push(call);
      host.respond(call.id, { ok: true, result: { echoed: call.method } });
    });

    bot.call("call-1", "getMe", { foo: "bar" });
    await flushMacrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: "call-1", method: "getMe", payload: { foo: "bar" } });

    const results = bot.results();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "call-1",
      kind: "result",
      platform: "telegram",
      payload: { ok: true, result: { echoed: "getMe" } },
    });
  });

  it("correlates concurrent calls by id even when answered out of order", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();

    const received: BotCall[] = [];
    host.onCall((call) => received.push(call));

    bot.call("a", "getMe", {});
    bot.call("b", "getMe", {});
    await flushMacrotasks();
    expect(received.map((call) => call.id)).toEqual(["a", "b"]);

    // Answer out of order.
    host.respond("b", { ok: true, result: "second" });
    host.respond("a", { ok: true, result: "first" });
    await flushMacrotasks();

    const results = bot.results();
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "b")?.payload).toEqual({ ok: true, result: "second" });
    expect(results.find((r) => r.id === "a")?.payload).toEqual({ ok: true, result: "first" });
  });

  it("rejects responding to an id that was never received as a call", async () => {
    const { host, bot } = connect();
    cleanups.push(() => {
      host.close();
      bot.close();
    });

    bot.sendHello();
    await flushMacrotasks();

    expect(() => host.respond("nope", {})).toThrow();
  });
});

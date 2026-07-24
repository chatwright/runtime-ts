import { describe, expect, it } from "vitest";

import { Session } from "../session/session.js";
import type { BotCall, BotTransport } from "../transport/transport.js";
import type { TelegramUpdate } from "../telegram/codec.js";
import type { PlatformUser } from "../platform/codec.js";
import { ObserveEngine, journalerOf } from "../observe/engine.js";
import { CampaignState } from "../goal/campaign.js";
import type { Goal } from "../goal/goal.js";
import { ScriptedProvider } from "./scripted-provider.js";
import type { Provider, Usage } from "./provider.js";
import { Loop, SessionActuator, type LoopConfig } from "./loop.js";

const USER: PlatformUser = { id: 7, firstName: "Tester" };
const CHAT_ID = 1;
const USAGE: Usage = { model: "scripted", inputTokens: 1, outputTokens: 1, latencyMs: 0 };

/** A bot that replies `"ok"` to any text — enough to make a send-text proposal register a real effect. */
class EchoBot implements BotTransport {
  #handler: ((call: BotCall) => void) | undefined;
  readonly #results = new Map<string, unknown>();
  #seq = 0;
  onCall(handler: (call: BotCall) => void): void {
    this.#handler = handler;
  }
  respond(id: string, result: unknown): void {
    this.#results.set(id, result);
  }
  deliverUpdate(update: unknown): void {
    const u = update as TelegramUpdate;
    if (u.message !== undefined) this.#call("sendMessage", { chat_id: u.message.chat.id, text: "ok" });
  }
  close(): void {}
  #call(method: string, params: unknown): void {
    const id = `b${++this.#seq}`;
    this.#handler?.({ id, method, payload: params });
    this.#results.delete(id);
  }
}

/** A bot that never replies to anything — so every actor action produces no effect. */
class SilentBot implements BotTransport {
  onCall(): void {}
  respond(): void {}
  deliverUpdate(): void {}
  close(): void {}
}

function wire(goal: Goal, bot: BotTransport, provider: Provider, config?: Partial<LoopConfig>): { loop: Loop; campaign: CampaignState; session: Session } {
  const clock = () => 1_000;
  const session = new Session();
  session.registerBot(bot);
  const engine = new ObserveEngine(journalerOf(session.journal(CHAT_ID)), { chatId: CHAT_ID });
  const campaign = new CampaignState(goal, clock);
  const actuator = new SessionActuator(session);
  const loop = new Loop(provider, engine, actuator, campaign, goal, {
    chatId: CHAT_ID,
    user: USER,
    now: clock,
    ...config,
  });
  return { loop, campaign, session };
}

describe("Loop: happy path with a ScriptedProvider", () => {
  it("drives send-text then task-done to a clean goal-complete", async () => {
    const goal: Goal = { id: "g", title: "greet", tasks: [{ id: "t" }], budgets: { maxSteps: 10 } };
    const provider = new ScriptedProvider(
      USAGE,
      { kind: "send-text", text: "hi", rationale: "open" },
      { kind: "task-done", rationale: "done" },
    );
    const { loop, campaign } = wire(goal, new EchoBot(), provider);

    const result = await loop.runTask("t");

    expect(result.status).toBe("completed");
    expect(result.stopped).toBe(true);
    expect(result.nonProgress).toBe(false);
    expect(campaign.stopReason()).toBe("goal-complete");

    const events = loop.events();
    expect(events.map((e) => e.action?.kind)).toEqual(["executed", "task-completed"]);
  });
});

describe("Loop: non-progress abort", () => {
  it("aborts the campaign after nonProgressLimit consecutive no-effect actions", async () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t" }] };
    const provider = new ScriptedProvider(
      USAGE,
      { kind: "send-text", text: "hi", rationale: "1" },
      { kind: "send-text", text: "hi", rationale: "2" },
      { kind: "send-text", text: "hi", rationale: "3" },
      { kind: "send-text", text: "hi", rationale: "4" },
    );
    const { loop, campaign } = wire(goal, new SilentBot(), provider, { nonProgressLimit: 3 });

    const result = await loop.runTask("t");

    expect(result.nonProgress).toBe(true);
    expect(result.stopped).toBe(true);
    expect(campaign.stopReason()).toBe("error"); // abort → StopError
    const events = loop.events();
    expect(events).toHaveLength(3); // aborted the moment the streak hit the limit
    expect(events.every((e) => e.action?.kind === "executed-no-effect")).toBe(true);
  });
});

describe("Loop: stale-click rejection", () => {
  it("records a stale click as skipped-invalid and never submits it", async () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t" }] };
    const provider = new ScriptedProvider(
      USAGE,
      { kind: "click", actionId: "does-not-exist", observationSequence: 1, rationale: "1" },
      { kind: "click", actionId: "does-not-exist", observationSequence: 1, rationale: "2" },
      { kind: "click", actionId: "does-not-exist", observationSequence: 1, rationale: "3" },
    );
    const { loop, session } = wire(goal, new SilentBot(), provider, { nonProgressLimit: 3 });

    const result = await loop.runTask("t");

    expect(result.nonProgress).toBe(true);
    const events = loop.events();
    expect(events[0]!.validation?.checked).toBe(true);
    expect(events[0]!.validation?.verdict).toBe("stale");
    expect(events[0]!.action?.kind).toBe("skipped-invalid");
    // Nothing was ever submitted to the bot: the chat's journal is empty.
    expect(session.journal(CHAT_ID).entries()).toHaveLength(0);
  });
});

describe("Loop: premature task-done rejection", () => {
  it("rejects a task-done proposed before evidence-defined criteria hold", async () => {
    const goal: Goal = {
      id: "g",
      tasks: [{ id: "t", criteria: () => false }],
    };
    const provider = new ScriptedProvider(
      USAGE,
      { kind: "task-done", rationale: "1" },
      { kind: "task-done", rationale: "2" },
      { kind: "task-done", rationale: "3" },
    );
    const { loop, campaign } = wire(goal, new SilentBot(), provider, { nonProgressLimit: 3 });

    const result = await loop.runTask("t");

    expect(campaign.taskStatus("t")).not.toBe("completed");
    expect(result.nonProgress).toBe(true);
    const events = loop.events();
    expect(events[0]!.action?.kind).toBe("skipped-invalid");
    expect(events[0]!.action?.detail).toContain("before evidence-defined criteria");
  });
});

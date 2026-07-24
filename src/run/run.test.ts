import { describe, expect, it } from "vitest";

import { Session } from "../session/session.js";
import { GreetbotBot } from "../testkit/greetbot-bot.js";
import type { PlatformUser } from "../platform/codec.js";
import { executeRun, RunConfigError, type DeterministicPart, type Run, type RunProgress } from "./run.js";
import { GREETBOT_CHAT_ID } from "../scenario/greetbot.js";

const USER: PlatformUser = { id: 7, firstName: "Tester" };

function deterministicRun(session: Session): Run {
  const part: DeterministicPart = {
    kind: "deterministic",
    id: "onboarding",
    title: "Pick English",
    chatId: GREETBOT_CHAT_ID,
    user: USER,
    steps: [
      { kind: "send-text", text: "/start" },
      { kind: "click", label: "English" },
      { kind: "send-text", text: "Thanks!" },
    ],
    assertions: [
      { kind: "text-equals", botTurn: 1, text: "Howdy stranger" },
      { kind: "edited", botTurn: 1 },
      { kind: "expects-action", botTurn: 1, label: "Español" },
      { kind: "text-equals", botTurn: 2, text: "Howdy stranger" },
    ],
  };
  return { id: "det-run", environment: { session, chatIds: [GREETBOT_CHAT_ID], now: () => 1_000 }, parts: [part] };
}

describe("executeRun: deterministic part", () => {
  it("performs steps against the bot then evaluates assertions, capturing the journal boundary", async () => {
    const session = new Session();
    session.registerBot(new GreetbotBot());

    const progress: RunProgress[] = [];
    const assertionEvents: string[] = [];
    const result = await executeRun(deterministicRun(session), {
      onProgress: (p) => progress.push(p),
      onAssertion: (partId, outcome) => assertionEvents.push(`${partId}:${outcome.verdict}`),
    });

    const part = result.parts[0]!;
    expect(part.kind).toBe("deterministic");
    expect(part.status).toBe("completed");
    expect(part.assertions!.map((a) => a.verdict)).toEqual(["pass", "pass", "pass", "pass"]);

    // The whole conversation is one boundary over chat 42, starting at entry 0.
    expect(part.boundary.chats).toEqual([
      { chatId: GREETBOT_CHAT_ID, firstEntry: 0, entryCount: session.journal(GREETBOT_CHAT_ID).entries().length },
    ]);

    // The Studio-facing subscription seams fired.
    expect(progress.map((p) => p.kind)).toEqual(["part-started", "part-completed"]);
    expect(assertionEvents).toEqual(["onboarding:pass", "onboarding:pass", "onboarding:pass", "onboarding:pass"]);
  });

  it("marks the part failed when an assertion fails", async () => {
    const session = new Session();
    session.registerBot(new GreetbotBot());
    const run = deterministicRun(session);
    const withBadAssertion: Run = {
      ...run,
      parts: [{ ...(run.parts[0] as DeterministicPart), assertions: [{ kind: "text-equals", botTurn: 1, text: "Bonjour" }] }],
    };
    const result = await executeRun(withBadAssertion);
    expect(result.parts[0]!.status).toBe("failed");
    expect(result.parts[0]!.assertions![0]!.verdict).toBe("fail");
  });
});

describe("executeRun: configuration validation", () => {
  it("rejects a part targeting an undeclared chat", async () => {
    const session = new Session();
    session.registerBot(new GreetbotBot());
    const run: Run = {
      id: "r",
      environment: { session, chatIds: [1], now: () => 0 },
      parts: [
        {
          kind: "deterministic",
          id: "p",
          chatId: 999,
          user: USER,
          steps: [],
          assertions: [],
        },
      ],
    };
    await expect(executeRun(run)).rejects.toBeInstanceOf(RunConfigError);
  });

  it("rejects duplicate part ids", async () => {
    const session = new Session();
    session.registerBot(new GreetbotBot());
    const part: DeterministicPart = { kind: "deterministic", id: "dup", chatId: 1, user: USER, steps: [], assertions: [] };
    const run: Run = { id: "r", environment: { session, chatIds: [1], now: () => 0 }, parts: [part, part] };
    await expect(executeRun(run)).rejects.toThrow(/duplicate part id/);
  });
});

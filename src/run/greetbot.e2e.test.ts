import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { Session } from "../session/session.js";
import { GreetbotBot } from "../testkit/greetbot-bot.js";
import { evaluateAssertions } from "../deterministic/assertions.js";
import { executeRun } from "./run.js";
import { buildRunBundle } from "./bundle.js";
import {
  buildGreetbotRun,
  greetbotAssertions,
  GREETBOT_ACTOR_ID,
  GREETBOT_CHAT_ID,
  GREETBOT_TASK_ID,
} from "../scenario/greetbot.js";

const schemaPath = fileURLToPath(new URL("../session/__fixtures__/run-bundle.v1.schema.json", import.meta.url));

let validateBundle: ValidateFunction;
beforeAll(() => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", { type: "string", validate: (value: string) => !Number.isNaN(Date.parse(value)) });
  validateBundle = ajv.compile(schema);
});

/** A deterministic wall clock for the session's journal/bundle timestamps. */
function tickClock(startIso: string, stepMs = 1000): () => Date {
  let current = new Date(startIso).getTime();
  return () => {
    const date = new Date(current);
    current += stepMs;
    return date;
  };
}

describe("greetbot scenario: end-to-end parity proof", () => {
  it("drives the loop to completion, the deterministic evidence passes, and a schema-valid bundle is emitted", async () => {
    const session = new Session({
      clock: tickClock("2026-07-24T12:00:00.000Z"),
      human: { id: GREETBOT_ACTOR_ID, type: "ai-agent", name: "Arena" },
      bot: { id: "greetbot", type: "bot", name: "GreetBot" },
    });
    session.registerBot(new GreetbotBot());

    const run = buildGreetbotRun(session, { now: () => 1_000 });
    const result = await executeRun(run);

    // (1) The loop drove the campaign to a clean completion.
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0]!;
    expect(part.kind).toBe("ai-goal");
    expect(part.status).toBe("completed");

    const aiGoal = part.aiGoal!;
    expect(aiGoal.report.stopReason).toBe("goal-complete");
    const task = aiGoal.report.tasks.find((t) => t.taskId === GREETBOT_TASK_ID)!;
    expect(task.status).toBe("completed");
    expect(task.attempted).toBe(true);
    expect(aiGoal.report.findings).toEqual([]); // a clean run: no navigation-failure/overshoot/constraint findings

    // (2) Evidence over claims: the deterministic journal re-check verifies it independently.
    expect(aiGoal.verify).toEqual({
      verified: true,
      detail: "started, clicked English, acknowledged — all journal-verified",
    });

    // (3) The data-driven deterministic assertions all pass against the finished journal.
    const entries = session.journal(GREETBOT_CHAT_ID).entries();
    const assertionOutcomes = evaluateAssertions(entries, greetbotAssertions());
    expect(assertionOutcomes.map((o) => o.verdict)).toEqual(["pass", "pass", "pass", "pass"]);

    // (4) A schema-valid run-bundle is emitted, filling the reserved aiGoal section.
    const bundle = buildRunBundle(session, result, {
      providers: { [GREETBOT_ACTOR_ID]: { name: "greetbot-policy", modelIds: ["greetbot-policy"] } },
    });
    const valid = validateBundle(bundle);
    if (!valid) throw new Error(`bundle failed schema validation: ${JSON.stringify(validateBundle.errors, null, 2)}`);
    expect(valid).toBe(true);

    // The aiGoal section round-trips into the bundle with its report + events.
    const wireRun = (bundle as { runs: { parts: { kind: string; aiGoal?: { report: { stopReason: string }; events: unknown[] } }[]; actors: { id: string; provider?: unknown }[] }[] }).runs[0]!;
    const wirePart = wireRun.parts[0]!;
    expect(wirePart.kind).toBe("ai-goal");
    expect(wirePart.aiGoal!.report.stopReason).toBe("goal-complete");
    expect(wirePart.aiGoal!.events.length).toBeGreaterThan(0);
    expect(wireRun.actors.find((a) => a.id === GREETBOT_ACTOR_ID)?.provider).toEqual({
      name: "greetbot-policy",
      modelIds: ["greetbot-policy"],
    });
  });
});

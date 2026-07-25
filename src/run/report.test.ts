import { describe, expect, it } from "vitest";

import type { CampaignSnapshot } from "../goal/campaign.js";
import type { Goal } from "../goal/goal.js";
import type { LoopEvent } from "../actor/loop-event.js";
import { assembleReport } from "./report.js";

function snapshot(over: Partial<CampaignSnapshot>): CampaignSnapshot {
  return {
    goalId: "g",
    statuses: {},
    steps: 0,
    cost: 0,
    elapsedMs: 0,
    failures: {},
    stopped: true,
    stopReason: "goal-complete",
    ...over,
  };
}

function event(over: Partial<LoopEvent> & Pick<LoopEvent, "index" | "taskId">): LoopEvent {
  return { at: 0, observationSequence: over.index + 1, ...over } as LoopEvent;
}

describe("assembleReport", () => {
  it("reports a never-attempted task as a coverage gap", () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t", title: "T" }] };
    const report = assembleReport({ goal, campaign: snapshot({ statuses: { t: "pending" }, stopReason: "budget-steps" }), events: [] });
    expect(report.tasks[0]).toMatchObject({ taskId: "t", status: "pending", attempted: false });
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "coverage-gap", taskId: "t", summary: expect.stringContaining("never attempted") }),
    ]);
  });

  it("classifies a failed task with stale/invalid history as an ai-navigation-failure", () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t" }] };
    const events: LoopEvent[] = [
      event({
        index: 0,
        taskId: "t",
        validation: { checked: true, freshness: "stale", reason: "gone" },
        action: { kind: "skipped-invalid", detail: "stale" },
      }),
    ];
    const report = assembleReport({ goal, campaign: snapshot({ statuses: { t: "failed" }, failures: { t: 1 } }), events });
    const finding = report.findings.find((f) => f.kind === "ai-navigation-failure")!;
    expect(finding.taskId).toBe("t");
    expect(finding.evidence.loopEventIndexes).toEqual([0]);
    expect(finding.confidence).toBe("mechanical");
  });

  it("derives actor-overshoot and constraint-violation findings from event outcomes, regardless of task success", () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t" }] };
    const events: LoopEvent[] = [
      event({ index: 0, taskId: "t", action: { kind: "executed" } }),
      event({ index: 1, taskId: "t", action: { kind: "blocked-constraint-violation", detail: "no admin words" } }),
      event({ index: 2, taskId: "t", action: { kind: "overshoot-probe" } }),
    ];
    const report = assembleReport({ goal, campaign: snapshot({ statuses: { t: "completed" } }), events });
    expect(report.findings.map((f) => f.kind).sort()).toEqual(["actor-overshoot", "constraint-violation"]);
    const constraint = report.findings.find((f) => f.kind === "constraint-violation")!;
    expect(constraint.summary).toContain("no admin words");
  });

  it("appends caller findings verbatim and aggregates usage", () => {
    const goal: Goal = { id: "g", title: "Goal", tasks: [{ id: "t" }] };
    const events: LoopEvent[] = [
      event({ index: 0, taskId: "t", usage: { model: "m", inputTokens: 10, outputTokens: 4, latencyMs: 0 }, action: { kind: "executed" } }),
      event({ index: 1, taskId: "t", usage: { model: "m", inputTokens: 6, outputTokens: 2, latencyMs: 0 }, action: { kind: "task-completed" } }),
    ];
    const report = assembleReport({
      goal,
      campaign: snapshot({ statuses: { t: "completed" }, steps: 2 }),
      events,
      callerFindings: [{ kind: "verified-defect", taskId: "t", summary: "wrong reply", evidence: {}, confidence: "dtql-verified" }],
    });
    expect(report.usage).toEqual({ inputTokens: 16, outputTokens: 6, callCount: 2 });
    expect(report.findings.at(-1)).toMatchObject({ kind: "verified-defect", confidence: "dtql-verified" });
    expect(report.goalTitle).toBe("Goal");
  });
});

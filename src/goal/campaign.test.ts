import { describe, expect, it } from "vitest";

import { CampaignState } from "./campaign.js";
import { GoalError, type GoalErrorCode } from "./errors.js";
import type { Goal } from "./goal.js";
import type { StopReason } from "./status.js";

const MINUTE = 60_000;

/** An injectable, manually advanced clock (epoch ms) — the state machine never reads `Date.now`. */
class FakeClock {
  #t = Date.UTC(2026, 6, 22, 12, 0, 0);
  now = (): number => this.#t;
  advance(ms: number): void {
    this.#t += ms;
  }
}

/** Asserts that `fn` throws a {@link GoalError} carrying the expected `code`. */
function expectGoalError(fn: () => void, code: GoalErrorCode): void {
  try {
    fn();
    throw new Error(`expected a GoalError(${code}), but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(GoalError);
    expect((err as GoalError).code).toBe(code);
  }
}

function onboardingAddItemsGoal(): Goal {
  return {
    id: "listus",
    tasks: [
      { id: "onboarding", successCriteria: "user completes language selection" },
      { id: "add-items", dependsOn: ["onboarding"], successCriteria: "several items visible" },
      { id: "cleanup", successCriteria: "list is emptied at the end of the run" },
    ],
  };
}

describe("CampaignState: task transitions are guarded", () => {
  it("enforces eligibility, activation, terminalisation and finality", () => {
    const clock = new FakeClock();
    const campaign = new CampaignState(onboardingAddItemsGoal(), clock.now);

    expectGoalError(() => campaign.activate("add-items"), "task-not-eligible");
    expect(campaign.eligible("add-items")).toBe(false);
    expectGoalError(() => campaign.activate("does-not-exist"), "unknown-task");
    expectGoalError(() => campaign.complete("add-items"), "task-not-active");

    campaign.activate("onboarding");
    campaign.complete("onboarding");
    expect(campaign.eligible("add-items")).toBe(true);

    // Re-activating a terminal task is guarded.
    expectGoalError(() => campaign.activate("onboarding"), "task-not-activatable");

    campaign.activate("add-items");
    // Double-activation is guarded (no active -> active edge).
    expectGoalError(() => campaign.activate("add-items"), "task-not-activatable");

    campaign.complete("add-items");
    // A terminal task cannot be re-terminalised.
    expectGoalError(() => campaign.fail("add-items"), "task-not-active");
  });
});

describe("CampaignState: completeByEvidence", () => {
  it("stops the last-task completion with goal-met-by-evidence", () => {
    const campaign = new CampaignState({ id: "g", tasks: [{ id: "only" }] }, new FakeClock().now);
    campaign.activate("only");
    campaign.completeByEvidence("only");
    expect(campaign.taskStatus("only")).toBe("completed");
    expect(campaign.stopped()).toBe(true);
    expect(campaign.stopReason()).toBe("goal-met-by-evidence");
  });

  it("leaves the pre-existing Complete path stopping with goal-complete", () => {
    const campaign = new CampaignState({ id: "g", tasks: [{ id: "only" }] }, new FakeClock().now);
    campaign.activate("only");
    campaign.complete("only");
    expect(campaign.stopReason()).toBe("goal-complete");
  });

  it("does not stop the campaign for a non-final task", () => {
    const campaign = new CampaignState({ id: "g", tasks: [{ id: "first" }, { id: "second" }] }, new FakeClock().now);
    campaign.activate("first");
    campaign.completeByEvidence("first");
    expect(campaign.stopped()).toBe(false);
  });
});

describe("CampaignState: budgets produce deterministic stop reasons", () => {
  const cases: {
    name: string;
    want: StopReason;
    drive: (clock: FakeClock, campaign: CampaignState) => void;
  }[] = [
    {
      name: "steps budget",
      want: "budget-steps",
      drive: (_clock, campaign) => {
        campaign.recordStep();
        campaign.recordStep();
      },
    },
    {
      name: "duration budget",
      want: "budget-duration",
      drive: (clock, campaign) => {
        clock.advance(6 * MINUTE);
        campaign.recordStep();
      },
    },
    {
      name: "cost budget",
      want: "budget-cost",
      drive: (_clock, campaign) => {
        campaign.recordCost(0.6);
        expect(campaign.stopped()).toBe(false);
        campaign.recordCost(0.5);
        expect(campaign.cost()).toBeCloseTo(1.1);
      },
    },
    {
      name: "goal complete",
      want: "goal-complete",
      drive: (_clock, campaign) => {
        campaign.activate("onboarding");
        campaign.complete("onboarding");
      },
    },
    {
      name: "cancelled",
      want: "cancelled",
      drive: (_clock, campaign) => campaign.cancel(),
    },
    {
      name: "error",
      want: "error",
      drive: (_clock, campaign) => campaign.abort(),
    },
  ];

  it.each(cases)("$name -> $want", ({ drive, want }) => {
    const clock = new FakeClock();
    const goal: Goal = {
      id: "single-task",
      tasks: [{ id: "onboarding" }],
      budgets: { maxSteps: 2, maxDurationMs: 5 * MINUTE, maxCost: 1 },
    };
    const campaign = new CampaignState(goal, clock.now);

    drive(clock, campaign);

    expect(campaign.stopped()).toBe(true);
    expect(campaign.stopReason()).toBe(want);
    // Once stopped, further mutation is refused deterministically.
    expectGoalError(() => campaign.recordStep(), "campaign-stopped");
  });
});

describe("CampaignState: repeated-failure budget", () => {
  it("stops only once the same task fails MaxRepeatedFailures times", () => {
    const goal: Goal = {
      id: "listus",
      tasks: [{ id: "onboarding" }, { id: "add-items", dependsOn: ["onboarding"] }],
      budgets: { maxRepeatedFailures: 3 },
    };
    const campaign = new CampaignState(goal, new FakeClock().now);
    campaign.activate("onboarding");

    campaign.recordFailure("onboarding");
    campaign.recordFailure("onboarding");
    expect(campaign.stopped()).toBe(false);
    expect(campaign.failureCount("onboarding")).toBe(2);

    // A failure on a different task does not count toward onboarding's budget.
    campaign.recordFailure("add-items");
    expect(campaign.stopped()).toBe(false);

    campaign.recordFailure("onboarding");
    expect(campaign.stopped()).toBe(true);
    expect(campaign.stopReason()).toBe("repeated-failure");

    expectGoalError(() => campaign.recordFailure("onboarding"), "campaign-stopped");
  });
});

describe("CampaignState: construction and guards", () => {
  it("rejects a nil clock", () => {
    expectGoalError(
      () => new CampaignState(onboardingAddItemsGoal(), undefined as unknown as () => number),
      "nil-clock",
    );
  });

  it("rejects an invalid goal", () => {
    expectGoalError(
      () => new CampaignState({ id: "bad", tasks: [{ id: "a", dependsOn: ["missing"] }] }, new FakeClock().now),
      "unknown-dependency",
    );
  });

  it("rejects a negative cost without stopping the campaign", () => {
    const campaign = new CampaignState(onboardingAddItemsGoal(), new FakeClock().now);
    expectGoalError(() => campaign.recordCost(-0.01), "negative-cost");
    expect(campaign.stopped()).toBe(false);
  });

  it("refuses every mutation after a stop", () => {
    const campaign = new CampaignState(onboardingAddItemsGoal(), new FakeClock().now);
    campaign.cancel();

    const mutations: Record<string, () => void> = {
      activate: () => campaign.activate("onboarding"),
      complete: () => campaign.complete("onboarding"),
      fail: () => campaign.fail("onboarding"),
      block: () => campaign.block("onboarding"),
      skip: () => campaign.skip("onboarding"),
      recordStep: () => campaign.recordStep(),
      recordFailure: () => campaign.recordFailure("onboarding"),
      recordCost: () => campaign.recordCost(1),
      cancel: () => campaign.cancel(),
      abort: () => campaign.abort(),
    };
    for (const mutate of Object.values(mutations)) {
      expectGoalError(mutate, "campaign-stopped");
    }
  });
});

describe("CampaignState.snapshot", () => {
  it("is a detached copy", () => {
    const campaign = new CampaignState(onboardingAddItemsGoal(), new FakeClock().now);
    campaign.activate("onboarding");
    campaign.recordFailure("onboarding");

    const snap = campaign.snapshot();
    snap.statuses["onboarding"] = "completed"; // mutate the copy
    snap.failures["onboarding"] = 99;

    expect(campaign.taskStatus("onboarding")).toBe("active");
    expect(campaign.failureCount("onboarding")).toBe(1);
    expect(snap.goalId).toBe("listus");
    expect(snap.stopped).toBe(false);
  });
});

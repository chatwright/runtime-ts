import { describe, expect, it } from "vitest";

import { validateGoal, effectiveContentRules, type Goal } from "./goal.js";
import { checkContentRules } from "./content-rules.js";
import { GoalError, type GoalErrorCode } from "./errors.js";

/** Asserts that `fn` throws a {@link GoalError} carrying the expected `code`. */
function expectGoalError(fn: () => void, code: GoalErrorCode): void {
  expect(fn).toThrowError(GoalError);
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GoalError);
    expect((err as GoalError).code).toBe(code);
  }
}

describe("validateGoal", () => {
  it("rejects a dependency cycle", () => {
    const g: Goal = {
      id: "cyclic",
      tasks: [
        { id: "onboarding", dependsOn: ["add-items"] },
        { id: "add-items", dependsOn: ["onboarding"] },
      ],
    };
    expectGoalError(() => validateGoal(g), "dependency-cycle");
  });

  it("rejects an unknown dependency", () => {
    const g: Goal = { id: "dangling", tasks: [{ id: "add-items", dependsOn: ["onboarding"] }] };
    expectGoalError(() => validateGoal(g), "unknown-dependency");
  });

  it("rejects a self-dependency as a one-node cycle, not an unknown dependency", () => {
    const g: Goal = { id: "self", tasks: [{ id: "loop", dependsOn: ["loop"] }] };
    expectGoalError(() => validateGoal(g), "dependency-cycle");
  });

  it("rejects a duplicate task id", () => {
    const g: Goal = { id: "g", tasks: [{ id: "add-items" }, { id: "add-items" }] };
    expectGoalError(() => validateGoal(g), "duplicate-task-id");
  });

  it("rejects an empty task id", () => {
    const g: Goal = { id: "g", tasks: [{ id: "  " }] };
    expectGoalError(() => validateGoal(g), "empty-task-id");
  });

  it.each([
    ["negative max steps", { maxSteps: -1 }, "negative-budget"],
    ["negative max duration", { maxDurationMs: -1 }, "negative-budget"],
    ["negative repeated failures", { maxRepeatedFailures: -1 }, "negative-budget"],
    ["zero max cost", { maxCost: 0 }, "non-positive-cost-budget"],
    ["negative max cost", { maxCost: -1 }, "non-positive-cost-budget"],
  ] as const)("rejects invalid budgets: %s", (_name, budgets, code) => {
    const g: Goal = { id: "g", tasks: [{ id: "only" }], budgets };
    expectGoalError(() => validateGoal(g), code);
  });

  it("accepts a well-formed goal", () => {
    const g: Goal = {
      id: "listus-shopping-list",
      title: "Exercise the shopping-list lifecycle",
      description: "Register a new user and exercise the shopping list end to end.",
      constraints: ["stay within the isolated test environment"],
      tasks: [
        { id: "onboarding", successCriteria: "user completes language selection", milestones: ["onboarding-complete"] },
        { id: "add-items", dependsOn: ["onboarding"], successCriteria: "several items visible", milestones: ["items-added"] },
        { id: "remove-items", dependsOn: ["add-items"], successCriteria: "list is empty again" },
      ],
      budgets: { maxSteps: 80, maxDurationMs: 0, maxRepeatedFailures: 3, maxCost: 5 },
    };
    expect(() => validateGoal(g)).not.toThrow();
  });

  it("accepts diamond dependencies (a valid DAG, not a cycle)", () => {
    const g: Goal = {
      id: "diamond",
      tasks: [
        { id: "start" },
        { id: "left", dependsOn: ["start"] },
        { id: "right", dependsOn: ["start"] },
        { id: "end", dependsOn: ["left", "right"] },
      ],
    };
    expect(() => validateGoal(g)).not.toThrow();
  });
});

describe("content rules", () => {
  it("checks deny-patterns before vocabulary, then a predicate", () => {
    const rules = {
      vocabulary: ["milk", "eggs"],
      denyPatterns: [/DROP TABLE/i],
    };
    expect(checkContentRules(rules, "add milk please").ok).toBe(true);
    expect(checkContentRules(rules, "add bananas").ok).toBe(false);
    // A denied pattern is reported even when an allowed term is also present.
    const denied = checkContentRules(rules, "milk; DROP TABLE users");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("denied pattern");
  });

  it("resolves task-over-goal for effective content rules", () => {
    const goal: Goal = { id: "g", tasks: [{ id: "t" }], contentRules: { vocabulary: ["goal-word"] } };
    const bareTask = goal.tasks[0]!;
    expect(effectiveContentRules(goal, bareTask).vocabulary).toEqual(["goal-word"]);

    const overriding = { ...bareTask, contentRules: { vocabulary: ["task-word"] } };
    expect(effectiveContentRules(goal, overriding).vocabulary).toEqual(["task-word"]);
  });
});

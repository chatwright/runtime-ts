/**
 * {@link Goal}/{@link Task} — a campaign's product-level intent and its
 * trackable units of work — plus {@link validateGoal}, ported from the Go
 * runtime's `goal/goal.go`.
 *
 * @remarks
 * This module is a pure contract: no AI, no emulator, no I/O. It has no
 * opinion on how a task is attempted — only on what a valid goal looks like
 * and which state transitions a campaign may legally make (see
 * {@link "./campaign.js".CampaignState}).
 */

import type { Observation } from "../observe/observe.js";
import { validateBudgets, type Budgets } from "./budgets.js";
import { isEmptyContentRules, type ContentRules } from "./content-rules.js";
import { GoalError } from "./errors.js";

/**
 * An optional, machine-checkable predicate for a task's completion: given the
 * current observation, it reports whether the task's success condition already
 * holds (evidence-defined completion). Returning `false` means "not yet met" —
 * the ordinary outcome, never an error. Throwing means evaluation itself
 * failed, surfaced to the caller driving the loop.
 *
 * @remarks
 * The Go runtime's `Criteria` closure carries a `context.Context`; the browser
 * port drops it. This field is Go-only/loop-facing and is never serialised.
 * The `CampaignState` machine never evaluates it — the actor loop (a follow-up
 * slice) does, then calls {@link "./campaign.js".CampaignState.completeByEvidence}.
 */
export type TaskCriteria = (obs: Observation) => boolean | Promise<boolean>;

/**
 * One trackable unit of work inside a {@link Goal}. Success is judged by prose
 * `successCriteria` — the contract never prescribes the bot commands or
 * callback data used to satisfy it. `dependsOn` names other task ids in the
 * same goal that must be completed before this task becomes eligible for
 * activation.
 */
export interface Task {
  readonly id: string;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  readonly successCriteria?: string;
  readonly milestones?: readonly string[];

  /**
   * Optional machine-checkable completion seam (loop-facing, never
   * serialised). When set, the loop evaluates it after every executed action
   * and completes the task deterministically the moment it holds.
   */
  readonly criteria?: TaskCriteria;

  /**
   * Optional machine-checkable content seam (loop-facing, never serialised).
   * When set (non-empty), it overrides the owning goal's own content rules for
   * this task entirely rather than merging — see {@link effectiveContentRules}.
   */
  readonly contentRules?: ContentRules;
}

/**
 * One campaign's product-level intent: a natural-language outcome broken into
 * {@link Task}s, plus the constraints and {@link Budgets} that bound how an
 * actor may pursue it. A goal describes intent, never platform mechanics.
 */
export interface Goal {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly tasks: readonly Task[];
  readonly constraints?: readonly string[];
  readonly budgets?: Budgets;

  /**
   * Optional content rules applied to every task that does not declare its own
   * (non-empty) rules (loop-facing, never serialised). See
   * {@link effectiveContentRules}.
   */
  readonly contentRules?: ContentRules;
}

/**
 * Resolves which {@link ContentRules} apply to `t` within `g`: `t`'s own rules
 * when they are non-empty, otherwise `g`'s ("task overriding goal"). A task
 * never merges its rules with its goal's; declaring any task-level rule takes
 * the goal-level rule out of the picture entirely for that task.
 */
export function effectiveContentRules(g: Goal, t: Task): ContentRules {
  if (t.contentRules !== undefined && !isEmptyContentRules(t.contentRules)) {
    return t.contentRules;
  }
  return g.contentRules ?? {};
}

/**
 * Checks that `g` is well-formed:
 *
 * - every task has a non-empty, unique id;
 * - every `dependsOn` entry resolves to another task id in `g`;
 * - the dependency graph is acyclic;
 * - budgets are non-negative, and `maxCost`, if set, is positive.
 *
 * Throws a {@link GoalError} on the first violation.
 * {@link "./campaign.js".CampaignState}'s constructor calls this, so a campaign
 * can never exist over an invalid goal.
 */
export function validateGoal(g: Goal): void {
  const ids = new Set<string>();
  g.tasks.forEach((task, i) => {
    if (task.id.trim() === "") {
      throw new GoalError("empty-task-id", `task id is empty: task at index ${i}`);
    }
    if (ids.has(task.id)) {
      throw new GoalError("duplicate-task-id", `duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
  });
  for (const task of g.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new GoalError(
          "unknown-dependency",
          `unknown dependency: task ${task.id} depends on unknown task ${dep}`,
        );
      }
    }
  }
  const cycle = findDependencyCycle(g.tasks);
  if (cycle !== undefined) {
    throw new GoalError("dependency-cycle", `dependency cycle: ${cycle.join(" -> ")}`);
  }
  validateBudgets(g.budgets ?? {});
}

/** DFS visitation state while searching for a dependency cycle. */
type Colour = "white" | "grey" | "black";

/**
 * Returns the first dependency cycle found, as an ordered list of task ids
 * starting and ending on the repeated task, or `undefined` if the graph is
 * acyclic. Callers must have already checked that every `dependsOn` reference
 * resolves to a known task.
 */
function findDependencyCycle(tasks: readonly Task[]): string[] | undefined {
  const byId = new Map<string, Task>();
  const colour = new Map<string, Colour>();
  for (const task of tasks) {
    byId.set(task.id, task);
    colour.set(task.id, "white");
  }

  const path: string[] = [];

  const visit = (id: string): string[] | undefined => {
    colour.set(id, "grey");
    path.push(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) {
      switch (colour.get(dep)) {
        case "grey": {
          const start = Math.max(0, path.indexOf(dep));
          return [...path.slice(start), dep];
        }
        case "white": {
          const cycle = visit(dep);
          if (cycle !== undefined) return cycle;
          break;
        }
        default:
          break;
      }
    }
    colour.set(id, "black");
    path.pop();
    return undefined;
  };

  for (const task of tasks) {
    if (colour.get(task.id) === "white") {
      const cycle = visit(task.id);
      if (cycle !== undefined) return cycle;
    }
  }
  return undefined;
}

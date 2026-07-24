/**
 * {@link CampaignState}: the guarded runtime state machine for one
 * {@link Goal}, ported from the Go runtime's `goal/campaign.go`.
 */

import { validateGoal, type Goal, type Task } from "./goal.js";
import { GoalError } from "./errors.js";
import { isTerminal, type StopReason, type TaskStatus } from "./status.js";

/**
 * A detached, point-in-time copy of a {@link CampaignState}'s progress: safe
 * to retain, log or compare after the originating state has moved on.
 */
export interface CampaignSnapshot {
  readonly goalId: string;
  readonly statuses: Record<string, TaskStatus>;
  readonly steps: number;
  readonly cost: number;
  /** Milliseconds elapsed between the campaign's start and this snapshot (or its stop). */
  readonly elapsedMs: number;
  readonly failures: Record<string, number>;
  readonly stopped: boolean;
  readonly stopReason: StopReason | "";
}

/**
 * The guarded runtime state machine for one {@link Goal}: task statuses,
 * elapsed steps and duration, per-task failure counts, and the deterministic
 * {@link StopReason} that ends the campaign. It performs no AI, networking or
 * platform I/O — callers report progress in with {@link CampaignState.recordStep},
 * {@link CampaignState.recordFailure} and the task-transition methods, and
 * read state back out.
 *
 * @remarks
 * Time comes from an injected clock (see the constructor) returning epoch
 * milliseconds, rather than `Date.now`, so tests are deterministic and
 * reproducible. Being single-threaded, the TypeScript port needs none of the
 * Go original's mutex.
 */
export class CampaignState {
  readonly #goal: Goal;
  readonly #tasks = new Map<string, Task>();
  readonly #now: () => number;

  readonly #statuses = new Map<string, TaskStatus>();
  readonly #failures = new Map<string, number>();
  #steps = 0;
  #cost = 0;
  readonly #startedAt: number;
  #stopped = false;
  #stopReason: StopReason | "" = "";
  #stoppedAt = 0;

  /**
   * Validates `goal` (see {@link validateGoal}) and starts a new campaign with
   * every task pending. `now` supplies the current time (epoch milliseconds)
   * for step duration and budget checks; pass a fake clock in tests so
   * duration-budget behaviour is deterministic. Throws a {@link GoalError}
   * (`"nil-clock"`) if `now` is not a function, or rethrows validation
   * failures.
   */
  constructor(goal: Goal, now: () => number) {
    if (typeof now !== "function") {
      throw new GoalError("nil-clock", "clock function is nil");
    }
    validateGoal(goal);

    this.#goal = goal;
    this.#now = now;
    for (const task of goal.tasks) {
      this.#tasks.set(task.id, task);
      this.#statuses.set(task.id, "pending");
    }
    this.#startedAt = now();
  }

  /** Returns the current status of the task with the given id, or throws `"unknown-task"`. */
  taskStatus(id: string): TaskStatus {
    const status = this.#statuses.get(id);
    if (status === undefined) throw new GoalError("unknown-task", `unknown task id: ${id}`);
    return status;
  }

  /**
   * Reports whether the task with the given id is currently pending and every
   * task it depends on is completed — the guard {@link CampaignState.activate}
   * enforces. Throws `"unknown-task"` if the id is unknown.
   */
  eligible(id: string): boolean {
    const status = this.#statuses.get(id);
    if (status === undefined) throw new GoalError("unknown-task", `unknown task id: ${id}`);
    return status === "pending" && this.#dependenciesComplete(id);
  }

  #dependenciesComplete(id: string): boolean {
    for (const dep of this.#tasks.get(id)!.dependsOn ?? []) {
      if (this.#statuses.get(dep) !== "completed") return false;
    }
    return true;
  }

  /**
   * Transitions a pending, dependency-satisfied task to active. Throws if the
   * campaign has stopped (`"campaign-stopped"`), the id is unknown
   * (`"unknown-task"`), the task's dependencies are not all completed
   * (`"task-not-eligible"`), or the task is not pending at all
   * (`"task-not-activatable"`).
   */
  activate(id: string): void {
    if (this.#stopped) throw this.#stoppedError();
    const status = this.#statuses.get(id);
    if (status === undefined) throw new GoalError("unknown-task", `unknown task id: ${id}`);
    if (status !== "pending") {
      throw new GoalError("task-not-activatable", `task is not activatable: ${id} is ${status}`);
    }
    if (!this.#dependenciesComplete(id)) {
      throw new GoalError("task-not-eligible", `task is not eligible (unmet dependencies): ${id}`);
    }
    this.#statuses.set(id, "active");
  }

  /**
   * Transitions an active task to completed — the actor's own task-done claim,
   * or any other caller-driven completion. If this transition leaves every
   * task terminal, the campaign stops with `"goal-complete"`.
   */
  complete(id: string): void {
    this.#terminalize(id, "completed", "goal-complete");
  }

  /**
   * Transitions an active task to completed because the loop's own
   * machine-checkable criteria evaluation found the task's success condition
   * already holds (evidence-defined completion) — never because the actor
   * itself proposed task-done (use {@link CampaignState.complete} for that).
   * Identical to `complete` except the resulting goal-complete stop uses
   * `"goal-met-by-evidence"` instead of `"goal-complete"`.
   */
  completeByEvidence(id: string): void {
    this.#terminalize(id, "completed", "goal-met-by-evidence");
  }

  /** Transitions an active task to failed. */
  fail(id: string): void {
    this.#terminalize(id, "failed", "goal-complete");
  }

  /** Transitions an active task to blocked. */
  block(id: string): void {
    this.#terminalize(id, "blocked", "goal-complete");
  }

  /** Transitions an active task to skipped. */
  skip(id: string): void {
    this.#terminalize(id, "skipped", "goal-complete");
  }

  #terminalize(id: string, target: TaskStatus, completionReason: StopReason): void {
    if (this.#stopped) throw this.#stoppedError();
    const status = this.#statuses.get(id);
    if (status === undefined) throw new GoalError("unknown-task", `unknown task id: ${id}`);
    if (status !== "active") {
      throw new GoalError("task-not-active", `task is not active: ${id} is ${status}`);
    }
    this.#statuses.set(id, target);
    this.#checkGoalComplete(completionReason);
  }

  /**
   * Stops the campaign with `reason` once every task has reached a terminal
   * status. It does not judge whether the outcome was a full success.
   */
  #checkGoalComplete(reason: StopReason): void {
    for (const status of this.#statuses.values()) {
      if (!isTerminal(status)) return;
    }
    this.#stop(reason);
  }

  /**
   * Counts one action/step against the campaign's step and duration budgets.
   * Stops the campaign deterministically (`"budget-steps"`, then
   * `"budget-duration"`) the moment a positive budget is reached, and throws
   * `"campaign-stopped"` if the campaign has already stopped.
   */
  recordStep(): void {
    if (this.#stopped) throw this.#stoppedError();
    this.#steps++;
    const budgets = this.#goal.budgets ?? {};
    const maxSteps = budgets.maxSteps ?? 0;
    if (maxSteps > 0 && this.#steps >= maxSteps) {
      this.#stop("budget-steps");
      return;
    }
    const maxDuration = budgets.maxDurationMs ?? 0;
    if (maxDuration > 0 && this.#now() - this.#startedAt >= maxDuration) {
      this.#stop("budget-duration");
    }
  }

  /**
   * Attributes one failed attempt to the task with the given id. Repeated
   * failures against the same task accumulate across calls; once the count
   * reaches a positive `maxRepeatedFailures` the campaign stops with
   * `"repeated-failure"`. Throws if the campaign has stopped or the id is
   * unknown.
   */
  recordFailure(id: string): void {
    if (this.#stopped) throw this.#stoppedError();
    if (!this.#statuses.has(id)) throw new GoalError("unknown-task", `unknown task id: ${id}`);
    const next = (this.#failures.get(id) ?? 0) + 1;
    this.#failures.set(id, next);
    const max = this.#goal.budgets?.maxRepeatedFailures ?? 0;
    if (max > 0 && next >= max) this.#stop("repeated-failure");
  }

  /**
   * Accrues `amount` against the campaign's cost budget. Costs accumulate
   * across calls for the life of the campaign, not per task. Stops the
   * campaign deterministically with `"budget-cost"` the moment accrued cost
   * reaches a set, positive `maxCost`, and throws if the campaign has stopped
   * or `amount` is negative.
   */
  recordCost(amount: number): void {
    if (this.#stopped) throw this.#stoppedError();
    if (amount < 0) throw new GoalError("negative-cost", `cost amount must not be negative: ${amount}`);
    this.#cost += amount;
    const max = this.#goal.budgets?.maxCost;
    if (max !== undefined && max > 0 && this.#cost >= max) this.#stop("budget-cost");
  }

  /** Stops the campaign with `"cancelled"` — an external decision to end early. Throws if already stopped. */
  cancel(): void {
    if (this.#stopped) throw this.#stoppedError();
    this.#stop("cancelled");
  }

  /** Stops the campaign with `"error"` after an unrecoverable runtime failure. Throws if already stopped. */
  abort(): void {
    if (this.#stopped) throw this.#stoppedError();
    this.#stop("error");
  }

  #stop(reason: StopReason): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopReason = reason;
    this.#stoppedAt = this.#now();
  }

  #stoppedError(): GoalError {
    return new GoalError("campaign-stopped", `campaign has already stopped: reason=${this.#stopReason}`);
  }

  /** Reports whether the campaign has stopped accepting mutations. */
  stopped(): boolean {
    return this.#stopped;
  }

  /** Returns the reason the campaign stopped, or `undefined` while it is still running. */
  stopReason(): StopReason | undefined {
    return this.#stopped ? (this.#stopReason as StopReason) : undefined;
  }

  /** Returns the number of steps {@link CampaignState.recordStep} has counted so far. */
  steps(): number {
    return this.#steps;
  }

  /** Returns the total cost {@link CampaignState.recordCost} has accrued so far. */
  cost(): number {
    return this.#cost;
  }

  /** Returns how many failures have been counted against the given task id (zero for an unknown id). */
  failureCount(id: string): number {
    return this.#failures.get(id) ?? 0;
  }

  /** Returns a detached copy of the campaign's current progress. */
  snapshot(): CampaignSnapshot {
    const statuses: Record<string, TaskStatus> = {};
    for (const [id, status] of this.#statuses) statuses[id] = status;
    const failures: Record<string, number> = {};
    for (const [id, n] of this.#failures) failures[id] = n;

    const elapsedAt = this.#stopped ? this.#stoppedAt : this.#now();
    return {
      goalId: this.#goal.id,
      statuses,
      steps: this.#steps,
      cost: this.#cost,
      elapsedMs: elapsedAt - this.#startedAt,
      failures,
      stopped: this.#stopped,
      stopReason: this.#stopReason,
    };
  }
}

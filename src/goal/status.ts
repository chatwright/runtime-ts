/**
 * Task lifecycle statuses and campaign stop reasons — string-literal unions
 * (never integer enums) so they marshal to human-readable JSON, ported from
 * the Go runtime's `goal/status.go`.
 */

/**
 * A task's position in its guarded lifecycle:
 *
 * ```
 * pending -> active -> completed | failed | blocked | skipped
 * ```
 *
 * Only a {@link "./campaign.js".CampaignState} mutates a task's status, and
 * only along that guard: a task must be activated before it can reach any
 * terminal status, and every terminal status is final.
 */
export type TaskStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

/**
 * Reports whether `status` is one of the lifecycle's terminal outcomes. Once
 * a task reaches a terminal status no further transition is possible.
 */
export function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "skipped"
  );
}

/**
 * Why a {@link "./campaign.js".CampaignState} stopped accepting further
 * mutations. Every stop names exactly one reason, chosen deterministically by
 * the condition that caused it.
 */
export type StopReason =
  /** Every task reached a terminal status — no more eligible work to activate. Does not by itself mean every task succeeded. */
  | "goal-complete"
  /** `Budgets.maxSteps` was reached. */
  | "budget-steps"
  /** `Budgets.maxDurationMs` elapsed. */
  | "budget-duration"
  /** `Budgets.maxRepeatedFailures` was reached for one task. */
  | "repeated-failure"
  /** `Budgets.maxCost` was reached via `recordCost`. */
  | "budget-cost"
  /** `cancel` was called. */
  | "cancelled"
  /** `abort` was called after an unrecoverable runtime failure. */
  | "error"
  /**
   * Every task reached a terminal status, and the transition that made the
   * LAST one terminal was a `completeByEvidence` call — the loop's own
   * machine-checkable criteria evaluation, not the actor's own task-done
   * claim, is what closed the campaign out. Otherwise exactly like
   * `"goal-complete"`; the distinct reason lets a report name evidence.
   */
  | "goal-met-by-evidence";

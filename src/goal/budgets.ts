/**
 * {@link Budgets}: the limits that bound one autonomous campaign run, ported
 * from the Go runtime's `goal/budgets.go`.
 */

import { GoalError } from "./errors.js";

/**
 * Bounds one campaign run. Every numeric field's zero (or absent) value means
 * "no limit"; a negative value is invalid.
 *
 * @remarks
 * Durations are milliseconds (the browser/TS clock unit — see
 * {@link "./campaign.js".CampaignState}), where the Go runtime used
 * `time.Duration` nanoseconds. `maxCost` is the one genuinely optional field:
 * `undefined` means cost is not budgeted at all.
 */
export interface Budgets {
  /** Caps the number of steps `recordStep` counts. `0`/absent means unlimited. */
  readonly maxSteps?: number;
  /** Caps wall-clock milliseconds elapsed since the campaign started, measured by the injected clock. `0`/absent means unlimited. */
  readonly maxDurationMs?: number;
  /** Caps how many times `recordFailure` may be called for a single task before the campaign stops. `0`/absent means unlimited. */
  readonly maxRepeatedFailures?: number;
  /** Optionally caps spend (tokens, currency or another caller-defined unit accrued via `recordCost`). `undefined` means cost is not budgeted. */
  readonly maxCost?: number;
}

/**
 * Rejects a negative `maxSteps`, `maxDurationMs` or `maxRepeatedFailures`,
 * and a `maxCost` that is set but not positive. Throws a {@link GoalError}.
 */
export function validateBudgets(b: Budgets): void {
  if ((b.maxSteps ?? 0) < 0) {
    throw new GoalError("negative-budget", `budget must not be negative: max steps = ${b.maxSteps}`);
  }
  if ((b.maxDurationMs ?? 0) < 0) {
    throw new GoalError("negative-budget", `budget must not be negative: max duration = ${b.maxDurationMs}`);
  }
  if ((b.maxRepeatedFailures ?? 0) < 0) {
    throw new GoalError("negative-budget", `budget must not be negative: max repeated failures = ${b.maxRepeatedFailures}`);
  }
  if (b.maxCost !== undefined && b.maxCost <= 0) {
    throw new GoalError("non-positive-cost-budget", `max cost budget must be positive when set: max cost = ${b.maxCost}`);
  }
}

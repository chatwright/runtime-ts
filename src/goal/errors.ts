/**
 * Typed errors for the `goal` module. The Go runtime uses sentinel errors
 * matched with `errors.Is`; the TypeScript port carries a stable, string-
 * literal `code` on a single {@link GoalError} class, so callers discriminate
 * on `err.code` (the browser-idiomatic twin of `errors.Is`) rather than on
 * fragile message text.
 */

/**
 * The stable discriminant of a {@link GoalError}. A string-literal union
 * (never an integer enum), matching this module's JSON-artefact convention.
 */
export type GoalErrorCode =
  // Goal.validate
  /** A task's id is empty or whitespace-only. */
  | "empty-task-id"
  /** Two tasks in the same goal share an id. */
  | "duplicate-task-id"
  /** A task's `dependsOn` entry does not name a task id present in the same goal. */
  | "unknown-dependency"
  /** The task dependency graph contains a cycle. */
  | "dependency-cycle"
  /** A budget field that must be zero (unlimited) or positive was set negative. */
  | "negative-budget"
  /** `maxCost` was set to zero or a negative value; leave it undefined to mean "not budgeted". */
  | "non-positive-cost-budget"
  // CampaignState
  /** A campaign was constructed without a clock function. */
  | "nil-clock"
  /** A task id does not belong to the campaign's goal. */
  | "unknown-task"
  /** `activate` was called on a pending task whose dependencies are not all completed. */
  | "task-not-eligible"
  /** `activate` was called on a task that was not pending (already active or terminal). */
  | "task-not-activatable"
  /** `complete`, `fail`, `block` or `skip` was called on a task that was not currently active. */
  | "task-not-active"
  /** A mutating method was called after the campaign had already stopped. */
  | "campaign-stopped"
  /** `recordCost` was called with a negative amount. */
  | "negative-cost";

/**
 * The single error type this module throws. Its {@link GoalError.code}
 * identifies the exact failure deterministically.
 */
export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}

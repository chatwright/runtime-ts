/**
 * {@link LoopEvent} and its outcome types: the structured record of one actor
 * loop iteration, ported from the Go runtime's `actor/loop_event.go`.
 *
 * @remarks
 * These are pure data types the actor loop (a follow-up slice) produces and
 * that the bounded {@link "./provider.js".Prompt.history} carries into a
 * provider. This foundation module defines them so the provider seam and the
 * OpenAI prompt renderer can consume them; it contains no loop logic.
 */

import type { Verdict } from "../observe/observe.js";
import type { Proposal, Usage } from "./provider.js";

/**
 * The loop's validate-step verdict for one proposal, carrying
 * {@link "../observe/engine.js".ObserveEngine.validate}'s own result when it
 * applies. `checked` is `false` for proposal kinds validation does not apply
 * to (`"send-text"`, `"task-done"`, `"give-up"`), leaving `verdict`/`reason`
 * meaningless.
 */
export interface ValidationOutcome {
  readonly checked: boolean;
  readonly verdict?: Verdict;
  readonly reason?: string;
}

/**
 * Classifies what happened when the loop acted on a proposal, or why it did
 * not act at all. A string-literal union (never an integer enum) so it
 * marshals to human-readable JSON.
 */
export type ActionOutcomeKind =
  /** The proposal failed validation (a stale click) or was malformed; nothing was submitted. */
  | "skipped-invalid"
  /** The proposed action was submitted and produced a semantically observable change. */
  | "executed"
  /** The proposed action was submitted, but the next observation showed no semantic change (a content-identical re-render). */
  | "executed-no-effect"
  /** A freshly validated proposal could not be resolved to a concrete platform action. */
  | "resolution-failed"
  /** A task-done proposal was accepted; the task was completed. */
  | "task-completed"
  /** A give-up proposal was accepted; the task was failed. */
  | "task-given-up"
  /** A send-text proposal's text violated the active task's (or goal's) content rules; nothing was submitted. */
  | "blocked-constraint-violation"
  /** A probe recorded strictly to measure whether the actor would keep acting after its task's criteria already held. */
  | "overshoot-probe";

/** What actually happened when the loop tried to act on a {@link "./provider.js".Proposal}. */
export interface ActionOutcome {
  readonly kind: ActionOutcomeKind;
  /** A human-readable explanation, set for `"skipped-invalid"`/`"resolution-failed"`, empty otherwise. */
  readonly detail?: string;
}

/**
 * One loop iteration's complete structured record: what was observed, what was
 * proposed, how the proposal validated, what happened when the loop acted on
 * it (or chose not to), and what it cost.
 */
export interface LoopEvent {
  /** 0-based and monotonic across one loop's lifetime. */
  readonly index: number;
  /** Stamped from the loop's injected clock (epoch ms), never `Date.now`. */
  readonly at: number;
  /** The task this iteration was attempting. */
  readonly taskId: string;
  /** The {@link "../observe/observe.js".Observation.sequence} this iteration observed before proposing. */
  readonly observationSequence: number;
  readonly proposal: Proposal;
  readonly usage: Usage;
  readonly validation: ValidationOutcome;
  readonly action: ActionOutcome;
  /** Set exactly when this iteration's call to a provider threw: the error's message. Absent otherwise. */
  readonly proposeError?: string;
}

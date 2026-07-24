/**
 * The actor {@link Provider} seam and its {@link Prompt}/{@link Proposal}/
 * {@link Usage} contract — the single interface to any concrete model or
 * vendor, ported from the Go runtime's `actor/provider.go`.
 *
 * @remarks
 * A provider is kept deliberately dumb: it reads a {@link Prompt} (goal/task
 * context, the current {@link "../observe/observe.js".Observation}, bounded
 * recent history) and returns a {@link Proposal} plus the {@link Usage} it
 * cost. Every safety property lives in the actor loop, never in a provider:
 * budgets and stop reasons come from
 * {@link "../goal/campaign.js".CampaignState}, click proposals are checked with
 * {@link "../observe/engine.js".ObserveEngine.validate}, and Chatwright
 * remains authoritative — an invalid proposal is recorded and re-prompted,
 * never silently acted on.
 */

import type { Observation } from "../observe/observe.js";
import type { LoopEvent } from "./loop-event.js";

/**
 * The result of one {@link Provider.propose} call: the typed intent and the
 * {@link Usage} it cost. (The Go runtime returns a `(Proposal, Usage, error)`
 * triple; the browser port resolves this object and throws on error.)
 */
export interface ProposeResult {
  readonly proposal: Proposal;
  readonly usage: Usage;
}

/**
 * Proposes the next action for an in-flight campaign task. A dumb transport:
 * read a {@link Prompt}, return a {@link Proposal} and the {@link Usage} it
 * cost. Nothing a provider returns is trusted blindly — the loop validates
 * every proposal before acting.
 */
export interface Provider {
  propose(prompt: Prompt): Promise<ProposeResult>;
}

/**
 * Everything a {@link Provider} needs to propose the next action: the
 * goal/active-task context, the current semantic
 * {@link "../observe/observe.js".Observation} — never raw platform payloads —
 * and bounded recent history.
 */
export interface Prompt {
  readonly goalId: string;
  readonly goalTitle: string;
  readonly goalDescription?: string;
  readonly constraints?: readonly string[];

  readonly taskId: string;
  readonly taskTitle?: string;
  readonly taskSuccessCriteria?: string;

  /**
   * The current semantic snapshot: visible messages, available actions and
   * explicit changes. A provider proposing a `"click"` must copy `actionId`
   * from an action listed here, and `observationSequence` from
   * `observation.sequence`.
   */
  readonly observation: Observation;

  /**
   * The loop's last N {@link LoopEvent}s preceding this prompt, oldest first.
   * It includes invalid/no-effect attempts, so a provider can see (and avoid
   * repeating) what did not work.
   */
  readonly history: readonly LoopEvent[];
}

/**
 * The typed shape of a provider's proposed action. A string-literal union
 * (never an integer enum) so it marshals to human-readable JSON — in cassette
 * files and everywhere else.
 */
export type ProposalKind = "send-text" | "click" | "task-done" | "give-up";

/**
 * A provider's typed intent for the next action, plus its free-text
 * rationale. The loop validates and executes it.
 */
export interface Proposal {
  readonly kind: ProposalKind;
  /** Set for `"send-text"`: the text to send as the user. */
  readonly text?: string;
  /** Set for `"click"`: an {@link "../observe/observe.js".AvailableAction.id} drawn from the prompt's observation. */
  readonly actionId?: string;
  /** The observation sequence the proposal was chosen from. Required for `"click"`; ignored otherwise. */
  readonly observationSequence?: number;
  /** Free text explaining the choice — never private chain-of-thought, just enough for a developer or the campaign report. */
  readonly rationale: string;
}

/**
 * What one {@link Provider.propose} call cost: model identity, token counts,
 * latency (milliseconds) and, optionally, a caller-priced cost. When `cost`
 * is set, the loop feeds it to
 * {@link "../goal/campaign.js".CampaignState.recordCost}.
 */
export interface Usage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly cost?: number;
}

/**
 * The evidence-backed campaign report — ported from the Go runtime's
 * `campaign/report.go` and `campaign/assemble.go`.
 *
 * @remarks
 * {@link assembleReport} builds a {@link CampaignReport} from a completed (or
 * budget-stopped) actor loop run: a {@link "../goal/goal.js".Goal}, the
 * {@link "../goal/campaign.js".CampaignSnapshot} it produced, and the
 * {@link "../actor/loop-event.js".LoopEvent}s the loop recorded. Findings are
 * derived mechanically; no AI-judged finding kind exists (out of scope).
 */

import type { CampaignSnapshot } from "../goal/campaign.js";
import type { Goal } from "../goal/goal.js";
import type { TaskStatus } from "../goal/status.js";
import { isTerminal } from "../goal/status.js";
import type { LoopEvent } from "../actor/loop-event.js";

/** The current version of {@link CampaignReport}'s JSON shape. */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Classifies one {@link Finding}. Exactly the kinds mechanical evidence (plus
 * an explicit caller hook) can ground — a string-literal union, never an
 * integer enum.
 */
export type FindingKind =
  /** The actor acted and the observed outcome was wrong — requires caller-supplied evidence; mechanics alone cannot derive this. */
  | "verified-defect"
  /** The task did not complete and its history shows the actor's own proposals going stale or invalid — the bot was never shown to be at fault. */
  | "ai-navigation-failure"
  /** A task the campaign never attempted, or never concluded, before it stopped — a gap in evidence, not a claim about the bot. */
  | "coverage-gap"
  /** The actor kept acting (or, via the overshoot probe, was shown to want to) after its task's completion criteria already held. */
  | "actor-overshoot"
  /** The actor proposed text that violated its content rules; the loop blocked it before it reached the bot. */
  | "constraint-violation";

/** How a {@link Finding} was derived. */
export type Confidence = "mechanical" | (string & {});

/** Links a {@link Finding} back to the observations and loop events that ground it. */
export interface Evidence {
  readonly observationSequences?: readonly number[];
  readonly loopEventIndexes?: readonly number[];
}

/** One reportable outcome of the campaign: a claim, classified, scoped to a task, linked to its evidence. */
export interface Finding {
  readonly kind: FindingKind;
  readonly taskId: string;
  readonly summary: string;
  readonly evidence: Evidence;
  /** `"mechanical"` for the deterministic rules {@link assembleReport} applies itself, or a caller's own label. */
  readonly confidence?: Confidence;
}

/** One task's evidence-grounded result within the campaign. */
export interface TaskOutcome {
  readonly taskId: string;
  readonly title?: string;
  readonly successCriteria?: string;
  readonly status: TaskStatus;
  /** `true` once at least one loop event was recorded for this task. */
  readonly attempted: boolean;
  readonly failureCount: number;
}

/** Sums the usage of every loop event a report was assembled from. */
export interface AggregateUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost?: number;
  /** The number of provider propose calls — i.e. the number of loop events. */
  readonly callCount: number;
}

/** One campaign run's complete, evidence-linked outcome: versioned, JSON-serialisable, portable. */
export interface CampaignReport {
  readonly schemaVersion: number;
  readonly goalId: string;
  readonly goalTitle: string;
  readonly stopReason: string;
  readonly steps: number;
  readonly cost?: number;
  /** Milliseconds elapsed (Go carries `time.Duration` nanoseconds — converted at wire time). */
  readonly elapsedMs: number;
  readonly tasks: readonly TaskOutcome[];
  readonly findings: readonly Finding[];
  readonly usage: AggregateUsage;
}

/** Everything {@link assembleReport} needs to build a {@link CampaignReport}. */
export interface AssembleInput {
  readonly goal: Goal;
  readonly campaign: CampaignSnapshot;
  readonly events: readonly LoopEvent[];
  /**
   * Findings this slice's mechanics cannot derive on their own (chiefly
   * `verified-defect`). Included verbatim, appended after the derived
   * findings — the caller's seam to plug verification in.
   */
  readonly callerFindings?: readonly Finding[];
}

/**
 * Builds a {@link CampaignReport} from `input`. Task outcomes are read
 * straight off the snapshot/goal; findings are derived mechanically per task
 * and per event (see the Go `campaign.Assemble` doc comment for the rules).
 */
export function assembleReport(input: AssembleInput): CampaignReport {
  const eventsByTask = groupEventsByTask(input.events);

  const tasks: TaskOutcome[] = [];
  const findings: Finding[] = [];
  for (const task of input.goal.tasks) {
    const events = eventsByTask.get(task.id) ?? [];
    const attempted = events.length > 0;
    const status = input.campaign.statuses[task.id] ?? "pending";

    tasks.push({
      taskId: task.id,
      title: task.title,
      successCriteria: task.successCriteria,
      status,
      attempted,
      failureCount: input.campaign.failures[task.id] ?? 0,
    });

    const finding = deriveFinding(task.id, status, attempted, events);
    if (finding !== undefined) findings.push(finding);
  }
  findings.push(...deriveMechanicalEventFindings(input.events));
  if (input.callerFindings) findings.push(...input.callerFindings);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    goalId: input.goal.id,
    goalTitle: input.goal.title ?? "",
    stopReason: input.campaign.stopReason,
    steps: input.campaign.steps,
    cost: input.campaign.cost > 0 ? input.campaign.cost : undefined,
    elapsedMs: input.campaign.elapsedMs,
    tasks,
    findings,
    usage: aggregateUsage(input.events),
  };
}

function groupEventsByTask(events: readonly LoopEvent[]): Map<string, LoopEvent[]> {
  const byTask = new Map<string, LoopEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.taskId) ?? [];
    list.push(event);
    byTask.set(event.taskId, list);
  }
  return byTask;
}

/** Applies the mechanical classification rules to one task. */
function deriveFinding(
  taskId: string,
  status: TaskStatus,
  attempted: boolean,
  events: readonly LoopEvent[],
): Finding | undefined {
  if (!attempted) {
    if (isTerminal(status)) {
      return coverageGapFinding(taskId, "task has a terminal status but no recorded loop events to evidence it");
    }
    return coverageGapFinding(taskId, "task was never attempted before the campaign stopped");
  }

  if (status === "failed" || status === "blocked") {
    const nav = navigationFailureEvidence(events);
    if (nav !== undefined) {
      return {
        kind: "ai-navigation-failure",
        taskId,
        summary: `task "${taskId}" did not complete; its history shows the actor's own proposals going stale or unresolvable, not a confirmed bot defect`,
        evidence: nav,
        confidence: "mechanical",
      };
    }
    return undefined; // a clean failure: mechanics can't classify it further.
  }

  if (!isTerminal(status)) {
    const last = events[events.length - 1]!;
    return {
      kind: "coverage-gap",
      taskId,
      summary: `task "${taskId}" was still in progress when the campaign stopped; its outcome is unverified`,
      evidence: { observationSequences: [last.observationSequence], loopEventIndexes: [last.index] },
    };
  }

  return undefined; // completed: no finding, see TaskOutcome.
}

/** Scans every event for the two self-describing outcome kinds, one finding per occurrence. */
function deriveMechanicalEventFindings(events: readonly LoopEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    switch (event.action?.kind) {
      case "overshoot-probe":
        findings.push({
          kind: "actor-overshoot",
          taskId: event.taskId,
          summary: `task "${event.taskId}": the actor proposed another action after its evidence-defined completion criteria already held (recorded, never executed)`,
          evidence: { observationSequences: [event.observationSequence], loopEventIndexes: [event.index] },
          confidence: "mechanical",
        });
        break;
      case "blocked-constraint-violation":
        findings.push({
          kind: "constraint-violation",
          taskId: event.taskId,
          summary: `task "${event.taskId}": the actor proposed text that violated its content rules (${event.action.detail ?? ""}); blocked before it reached the bot`,
          evidence: { observationSequences: [event.observationSequence], loopEventIndexes: [event.index] },
          confidence: "mechanical",
        });
        break;
      default:
        break;
    }
  }
  return findings;
}

function coverageGapFinding(taskId: string, summary: string): Finding {
  return { kind: "coverage-gap", taskId, summary, evidence: {} };
}

/** Scans a task's events for a stale/invalid validation or an unresolvable action. */
function navigationFailureEvidence(events: readonly LoopEvent[]): Evidence | undefined {
  const sequences: number[] = [];
  const indexes: number[] = [];
  for (const event of events) {
    const stale = event.validation?.checked === true && event.validation.verdict === "stale";
    const invalid = event.action?.kind === "skipped-invalid" || event.action?.kind === "resolution-failed";
    if (stale || invalid) {
      sequences.push(event.observationSequence);
      indexes.push(event.index);
    }
  }
  return indexes.length > 0 ? { observationSequences: sequences, loopEventIndexes: indexes } : undefined;
}

function aggregateUsage(events: readonly LoopEvent[]): AggregateUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const event of events) {
    inputTokens += event.usage?.inputTokens ?? 0;
    outputTokens += event.usage?.outputTokens ?? 0;
    if (event.usage?.cost !== undefined) cost += event.usage.cost;
  }
  return { inputTokens, outputTokens, cost: cost > 0 ? cost : undefined, callCount: events.length };
}

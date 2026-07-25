/**
 * Run-bundle v1 emission: turns a completed {@link Run} into a
 * schema-valid run-bundle document, filling the reserved `aiGoal` section for
 * every ai-goal part.
 *
 * @remarks
 * Reuses {@link "../session/session.js".Session.toBundle} for the base
 * (format, metadata, actor roster, per-chat journals) and replaces its single
 * deterministic part with the run's actual parts, each carrying its journal
 * boundary and — for ai-goal parts — the goal, loop events, retained
 * observations and campaign report. Every converter here is a mechanical,
 * field-for-field mapping to the wire shape the
 * `formats/run-bundle/v1` schema defines; durations become nanoseconds and
 * loop-event timestamps become ISO date-time strings, matching the Go
 * runtime's wire output.
 */

import type { Session } from "../session/session.js";
import type { Observation } from "../observe/observe.js";
import type { LoopEvent } from "../actor/loop-event.js";
import type { Proposal, Usage } from "../actor/provider.js";
import type { ValidationOutcome, ActionOutcome } from "../actor/loop-event.js";
import type { Goal, Task } from "../goal/goal.js";
import type { Budgets } from "../goal/budgets.js";
import type { CampaignReport, Finding, TaskOutcome, AggregateUsage } from "./report.js";
import type { AIGoalOutcome, JournalBoundary, PartOutcome, RunResult } from "./run.js";

/** Provider/model provenance recorded on an ai-agent actor. */
export interface BundleActorProvider {
  readonly name?: string;
  readonly modelIds?: readonly string[];
}

/** Options for {@link buildRunBundle}. */
export interface BuildBundleOptions {
  /** Provider provenance to attach to a roster actor, keyed by actor id (the ai-goal part's `actorId`). */
  readonly providers?: Readonly<Record<string, BundleActorProvider>>;
  /** Overrides the run's `endpointProfile` (defaults to whatever `Session.toBundle` recorded, `"platform-emulated"`). */
  readonly endpointProfile?: string;
}

const NS_PER_MS = 1_000_000;

/**
 * Builds a run-bundle v1 document from `session` (the base) and `result` (the
 * run's parts). The returned value is a plain JSON object — validate it
 * structurally with a schema validator rather than trusting a compile-time
 * type.
 */
export function buildRunBundle(session: Session, result: RunResult, options: BuildBundleOptions = {}): unknown {
  const bundle = session.toBundle() as {
    runs: {
      endpointProfile: string;
      actors: { id: string; provider?: unknown }[];
      parts: unknown[];
    }[];
  };

  const run = bundle.runs[0];
  if (run !== undefined) {
    run.parts = result.parts.map(wirePart);
    if (options.endpointProfile !== undefined) run.endpointProfile = options.endpointProfile;
    if (options.providers !== undefined) {
      for (const actor of run.actors) {
        const provider = options.providers[actor.id];
        if (provider !== undefined) actor.provider = wireProvider(provider);
      }
    }
  }

  return bundle;
}

function wireProvider(provider: BundleActorProvider): Record<string, unknown> {
  return {
    ...(provider.name !== undefined ? { name: provider.name } : {}),
    ...(provider.modelIds !== undefined ? { modelIds: [...provider.modelIds] } : {}),
  };
}

function wirePart(part: PartOutcome): Record<string, unknown> {
  return {
    id: part.partId,
    ...(part.title !== undefined ? { title: part.title } : {}),
    kind: part.kind,
    journalBoundary: wireBoundary(part.boundary),
    ...(part.aiGoal !== undefined ? { aiGoal: wireAIGoalSection(part.aiGoal) } : {}),
  };
}

function wireBoundary(boundary: JournalBoundary): Record<string, unknown> {
  return {
    chats: boundary.chats.map((c) => ({ chatId: c.chatId, firstEntry: c.firstEntry, entryCount: c.entryCount })),
  };
}

function wireAIGoalSection(aiGoal: AIGoalOutcome): Record<string, unknown> {
  return {
    goal: wireGoal(aiGoal.goal),
    actorId: aiGoal.actorId,
    events: aiGoal.events.map(wireLoopEvent),
    observations: wireRetainedObservations(aiGoal.observations),
    report: wireReport(aiGoal.report),
  };
}

// ---- goal ------------------------------------------------------------------

function wireGoal(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    title: goal.title ?? "",
    description: goal.description ?? "",
    tasks: goal.tasks.map(wireTask),
    constraints: goal.constraints ? [...goal.constraints] : null,
    budgets: wireBudgets(goal.budgets ?? {}),
  };
}

function wireTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title ?? "",
    dependsOn: task.dependsOn ? [...task.dependsOn] : null,
    successCriteria: task.successCriteria ?? "",
    milestones: task.milestones ? [...task.milestones] : null,
  };
}

function wireBudgets(budgets: Budgets): Record<string, unknown> {
  return {
    maxSteps: budgets.maxSteps ?? 0,
    maxDurationNanoseconds: Math.round((budgets.maxDurationMs ?? 0) * NS_PER_MS),
    maxRepeatedFailures: budgets.maxRepeatedFailures ?? 0,
    maxCost: budgets.maxCost !== undefined ? budgets.maxCost : null,
  };
}

// ---- loop events -----------------------------------------------------------

function wireLoopEvent(event: LoopEvent): Record<string, unknown> {
  return {
    index: event.index,
    at: new Date(event.at).toISOString(),
    taskId: event.taskId,
    observationSequence: event.observationSequence,
    proposal: wireProposal(event.proposal),
    usage: wireUsage(event.usage),
    validation: wireValidation(event.validation),
    action: wireAction(event.action),
    ...(event.proposeError !== undefined ? { proposeError: event.proposeError } : {}),
  };
}

function wireProposal(proposal: Proposal | undefined): Record<string, unknown> {
  return {
    kind: proposal?.kind ?? "",
    text: proposal?.text ?? "",
    actionId: proposal?.actionId ?? "",
    observationSequence: proposal?.observationSequence ?? 0,
    rationale: proposal?.rationale ?? "",
  };
}

function wireUsage(usage: Usage | undefined): Record<string, unknown> {
  return {
    model: usage?.model ?? "",
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    latencyNanoseconds: Math.round((usage?.latencyMs ?? 0) * NS_PER_MS),
    ...(usage?.cost !== undefined ? { cost: usage.cost } : {}),
  };
}

function wireValidation(validation: ValidationOutcome | undefined): Record<string, unknown> {
  return {
    checked: validation?.checked ?? false,
    freshness: validation?.freshness ?? "",
    reason: validation?.reason ?? "",
  };
}

function wireAction(action: ActionOutcome | undefined): Record<string, unknown> {
  return {
    kind: action?.kind ?? "",
    detail: action?.detail ?? "",
  };
}

// ---- observations ----------------------------------------------------------

function wireRetainedObservations(observations: ReadonlyMap<number, Observation>): Record<string, unknown>[] {
  return [...observations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sequence, observation]) => ({ sequence, observation: wireObservation(observation) }));
}

function wireObservation(obs: Observation): Record<string, unknown> {
  return {
    sequence: obs.sequence,
    previousSequence: obs.previousSequence,
    chat: { chatId: obs.chat.chatId },
    messages: obs.messages.map((m) => ({
      id: m.id,
      version: m.version,
      edited: m.edited,
      actor: m.actor,
      text: m.text,
      actions: m.actions.length > 0 ? m.actions.map((a) => ({ id: a.id, label: a.label, seenAt: a.seenAt })) : null,
    })),
    changes: obs.changes.map((c) => ({
      kind: c.kind,
      messageId: c.messageId,
      actor: c.actor,
      previousVersion: c.previousVersion,
      version: c.version,
    })),
  };
}

// ---- report ----------------------------------------------------------------

function wireReport(report: CampaignReport): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    goalId: report.goalId,
    goalTitle: report.goalTitle,
    stopReason: report.stopReason,
    steps: report.steps,
    ...(report.cost !== undefined ? { cost: report.cost } : {}),
    elapsedNanoseconds: Math.round(report.elapsedMs * NS_PER_MS),
    tasks: report.tasks.map(wireTaskOutcome),
    findings: report.findings.map(wireFinding),
    usage: wireAggregateUsage(report.usage),
  };
}

function wireTaskOutcome(task: TaskOutcome): Record<string, unknown> {
  return {
    taskId: task.taskId,
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.successCriteria !== undefined ? { successCriteria: task.successCriteria } : {}),
    status: task.status,
    attempted: task.attempted,
    failureCount: task.failureCount,
  };
}

function wireFinding(finding: Finding): Record<string, unknown> {
  const evidence: Record<string, unknown> = {};
  if (finding.evidence.observationSequences !== undefined) {
    evidence.observationSequences = [...finding.evidence.observationSequences];
  }
  if (finding.evidence.loopEventIndexes !== undefined) {
    evidence.loopEventIndexes = [...finding.evidence.loopEventIndexes];
  }
  return {
    kind: finding.kind,
    taskId: finding.taskId,
    summary: finding.summary,
    evidence,
    ...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
  };
}

function wireAggregateUsage(usage: AggregateUsage): Record<string, unknown> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    callCount: usage.callCount,
  };
}

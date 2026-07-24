/**
 * The part-composition runtime: executes an ordered sequence of {@link Part}s
 * — deterministic scenario passages and ai-goal actor-loop passages — over one
 * shared {@link "../session/session.js".Session}, one continuous journal.
 * Ported in shape from the Go runtime's `run` package, adapted to this
 * runtime's {@link "../session/session.js".Session} model and to the
 * data-driven deterministic evaluator (`src/deterministic`).
 *
 * @remarks
 * An ai-goal part drives a {@link "../goal/campaign.js".CampaignState} through
 * an {@link "../actor/loop.js".Loop} exactly as a standalone campaign does,
 * scoped to that part's own goal and budgets. A deterministic part performs
 * its steps and then evaluates its {@link "../deterministic/assertions.js".Assertion}s
 * against the journal. Each part's journal boundary (per chat: first entry
 * index + entry count) is captured by snapshotting the session's journals
 * before and after the part runs.
 */

import type { Session } from "../session/session.js";
import type { PlatformUser } from "../platform/codec.js";
import type { JournalEntry, JournalAction } from "../journal/journal.js";
import { ObserveEngine, journalerOf } from "../observe/engine.js";
import type { Observation } from "../observe/observe.js";
import { CampaignState } from "../goal/campaign.js";
import type { Goal } from "../goal/goal.js";
import { Loop, SessionActuator, type LoopConfig, type ProgressSnapshot } from "../actor/loop.js";
import type { LoopEvent } from "../actor/loop-event.js";
import type { Provider } from "../actor/provider.js";
import { assembleReport, type CampaignReport, type Finding } from "./report.js";
import { evaluateAssertions, type Assertion, type AssertionOutcome, type EvaluateOptions } from "../deterministic/assertions.js";

/** The shared environment every {@link Part} in a {@link Run} executes over. */
export interface RunEnvironment {
  /** The one session (the emulator equivalent) every part acts against. */
  readonly session: Session;
  /** Every chat this run's journal spans, in the order boundary entries are reported. Must be non-empty. */
  readonly chatIds: readonly number[];
  /** This run's clock (epoch ms), used for the campaign/loop clock. */
  readonly now: () => number;
}

/** One step a deterministic {@link DeterministicPart} performs. */
export type DeterministicStep =
  | { readonly kind: "send-text"; readonly text: string }
  | { readonly kind: "click"; readonly label?: string; readonly actionId?: string };

/** A deterministic passage: perform `steps`, then evaluate `assertions` against the journal. */
export interface DeterministicPart {
  readonly kind: "deterministic";
  readonly id: string;
  readonly title?: string;
  readonly chatId: number;
  readonly user: PlatformUser;
  readonly steps: readonly DeterministicStep[];
  readonly assertions: readonly Assertion[];
  /** Optional pluggable verifier for side-effect (`data-state`) assertions. */
  readonly evaluate?: EvaluateOptions;
}

/** The evidence-over-claims re-check verdict a re-derived journal check produces. */
export interface VerifyResult {
  readonly verified: boolean;
  readonly detail: string;
}

/** An ai-goal passage: drive `provider` through a fresh campaign/loop for `goal`. */
export interface AIGoalPart {
  readonly kind: "ai-goal";
  readonly id: string;
  readonly title?: string;
  /** References the roster actor that runs this part's loop — becomes the ai-goal section's `actorId`. */
  readonly actorId: string;
  readonly chatId: number;
  readonly user: PlatformUser;
  readonly goal: Goal;
  readonly provider: Provider;
  /** Optional loop tunables (the run's clock and chat/user always win). */
  readonly loop?: Pick<
    LoopConfig,
    "historyWindow" | "nonProgressLimit" | "actWaitTimeoutMs" | "disableObservationRetention" | "disableOvershootProbe"
  >;
  /** Optional deterministic re-check of the journal, independent of the actor's own task-done claim (evidence over claims). */
  readonly verify?: (entries: readonly JournalEntry[]) => VerifyResult;
  /** Findings this run's mechanics cannot derive (e.g. verified-defect) — appended to the report verbatim. */
  readonly callerFindings?: readonly Finding[];
}

/** One declared passage of a {@link Run}. */
export type Part = DeterministicPart | AIGoalPart;

/** An ordered sequence of {@link Part}s executing over one {@link RunEnvironment}. */
export interface Run {
  readonly id: string;
  readonly environment: RunEnvironment;
  readonly parts: readonly Part[];
}

/** One chat's slice of a part's journal. */
export interface ChatBoundary {
  readonly chatId: number;
  readonly firstEntry: number;
  readonly entryCount: number;
}

/** A part's slice of the run-level journal. */
export interface JournalBoundary {
  readonly chats: readonly ChatBoundary[];
}

/** One executed part's outcome status. */
export type PartStatus = "completed" | "failed";

/** The retained ai-goal provenance a completed ai-goal part carries. */
export interface AIGoalOutcome {
  readonly goal: Goal;
  readonly actorId: string;
  readonly events: readonly LoopEvent[];
  readonly observations: ReadonlyMap<number, Observation>;
  readonly report: CampaignReport;
  /** The evidence-over-claims re-check verdict, when the part declared a verifier. */
  readonly verify?: VerifyResult;
}

/** One executed part's complete result. */
export interface PartOutcome {
  readonly partId: string;
  readonly title?: string;
  readonly kind: Part["kind"];
  readonly status: PartStatus;
  readonly boundary: JournalBoundary;
  /** Set for a deterministic part: one outcome per assertion, in order. */
  readonly assertions?: readonly AssertionOutcome[];
  /** Set for an ai-goal part. */
  readonly aiGoal?: AIGoalOutcome;
}

/** Everything {@link executeRun} produced. */
export interface RunResult {
  readonly runId: string;
  readonly parts: readonly PartOutcome[];
}

/** A live progress event a Studio UI can subscribe to. */
export type RunProgress =
  | { readonly kind: "part-started"; readonly partId: string; readonly partIndex: number; readonly partCount: number }
  | { readonly kind: "part-completed"; readonly partId: string; readonly partIndex: number; readonly partCount: number; readonly status: PartStatus }
  | { readonly kind: "loop"; readonly partId: string; readonly snapshot: ProgressSnapshot };

/** Options for {@link executeRun} — the live-progress subscription seams a Studio UI drives. */
export interface ExecuteOptions {
  /** Called at every part boundary and, for an ai-goal part, once per loop iteration/task boundary. */
  readonly onProgress?: (progress: RunProgress) => void;
  /** Called with each deterministic assertion outcome as it is evaluated. */
  readonly onAssertion?: (partId: string, outcome: AssertionOutcome) => void;
}

/** Thrown for a run-level configuration problem (never for a part's own execution failure). */
export class RunConfigError extends Error {
  constructor(message: string) {
    super(`run: ${message}`);
    this.name = "RunConfigError";
  }
}

/**
 * Executes every declared part in order over `run.environment`, capturing each
 * part's journal boundary and producing a {@link RunResult}. A part's own
 * execution failure is recorded as a `"failed"` {@link PartOutcome}, never
 * thrown; {@link RunConfigError} is reserved for a run-level configuration
 * problem discovered before any part runs.
 */
export async function executeRun(run: Run, options: ExecuteOptions = {}): Promise<RunResult> {
  validateRun(run);

  const parts: PartOutcome[] = [];
  const partCount = run.parts.length;

  for (let i = 0; i < run.parts.length; i++) {
    const part = run.parts[i]!;
    const partIndex = i + 1;
    options.onProgress?.({ kind: "part-started", partId: part.id, partIndex, partCount });

    const before = snapshotCounts(run.environment);
    const outcome =
      part.kind === "deterministic"
        ? await runDeterministic(run.environment, part, options)
        : await runAIGoal(run.environment, part, options);
    const after = snapshotCounts(run.environment);

    const boundary = diffBoundary(run.environment.chatIds, before, after);
    const complete: PartOutcome = { ...outcome, boundary };
    parts.push(complete);
    options.onProgress?.({ kind: "part-completed", partId: part.id, partIndex, partCount, status: complete.status });
  }

  return { runId: run.id, parts };
}

function validateRun(run: Run): void {
  if (run.id === "") throw new RunConfigError("Run.id is empty");
  if (run.environment.chatIds.length === 0) throw new RunConfigError("environment.chatIds is empty");
  if (typeof run.environment.now !== "function") throw new RunConfigError("environment.now is not a function");
  const declared = new Set(run.environment.chatIds);
  const seen = new Set<string>();
  for (const part of run.parts) {
    if (part.id === "") throw new RunConfigError("a part has an empty id");
    if (seen.has(part.id)) throw new RunConfigError(`duplicate part id "${part.id}"`);
    seen.add(part.id);
    if (!declared.has(part.chatId)) {
      throw new RunConfigError(`part "${part.id}" targets chat ${part.chatId}, which environment.chatIds does not declare`);
    }
  }
}

async function runDeterministic(
  env: RunEnvironment,
  part: DeterministicPart,
  options: ExecuteOptions,
): Promise<Omit<PartOutcome, "boundary">> {
  for (const step of part.steps) {
    performStep(env, part, step);
  }

  const entries = env.session.journal(part.chatId).entries();
  const assertions = evaluateAssertions(entries, part.assertions, part.evaluate);
  for (const outcome of assertions) options.onAssertion?.(part.id, outcome);

  const status: PartStatus = assertions.some((a) => a.verdict === "fail") ? "failed" : "completed";
  return { partId: part.id, title: part.title, kind: "deterministic", status, assertions };
}

function performStep(env: RunEnvironment, part: DeterministicPart, step: DeterministicStep): void {
  if (step.kind === "send-text") {
    env.session.submitText(part.chatId, part.user, step.text);
    return;
  }
  const entry = latestBotMessageEntry(env.session.journal(part.chatId).entries());
  const action = entry ? findAction(entry.actions ?? [], step.label, step.actionId) : undefined;
  if (entry === undefined || action === undefined) {
    throw new RunConfigError(
      `deterministic part "${part.id}": no action matching ${JSON.stringify({ label: step.label, actionId: step.actionId })} on the current bot message`,
    );
  }
  if (action.id) {
    env.session.submitClick(part.chatId, part.user, action.id, entry.messageId);
  } else {
    env.session.submitText(part.chatId, part.user, action.label);
  }
}

async function runAIGoal(
  env: RunEnvironment,
  part: AIGoalPart,
  options: ExecuteOptions,
): Promise<Omit<PartOutcome, "boundary">> {
  const engine = new ObserveEngine(journalerOf(env.session.journal(part.chatId)), { chatId: part.chatId });
  const campaign = new CampaignState(part.goal, env.now);
  const actuator = new SessionActuator(env.session);
  const config: LoopConfig = {
    ...part.loop,
    chatId: part.chatId,
    user: part.user,
    now: env.now,
    onProgress: options.onProgress
      ? (snapshot) => options.onProgress!({ kind: "loop", partId: part.id, snapshot })
      : undefined,
  };
  const loop = new Loop(part.provider, engine, actuator, campaign, part.goal, config);

  let status: PartStatus = "completed";
  try {
    await loop.runCampaign();
  } catch {
    status = "failed";
  }

  const events = loop.events();
  const report = assembleReport({
    goal: part.goal,
    campaign: campaign.snapshot(),
    events,
    callerFindings: part.callerFindings,
  });
  const verify = part.verify?.(env.session.journal(part.chatId).entries());

  return {
    partId: part.id,
    title: part.title,
    kind: "ai-goal",
    status,
    aiGoal: { goal: part.goal, actorId: part.actorId, events, observations: loop.observations(), report, verify },
  };
}

function snapshotCounts(env: RunEnvironment): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of env.chatIds) counts.set(id, env.session.journal(id).entries().length);
  return counts;
}

function diffBoundary(chatIds: readonly number[], before: Map<number, number>, after: Map<number, number>): JournalBoundary {
  const chats: ChatBoundary[] = [];
  for (const id of chatIds) {
    const firstEntry = before.get(id) ?? 0;
    const count = (after.get(id) ?? 0) - firstEntry;
    if (count <= 0) continue;
    chats.push({ chatId: id, firstEntry, entryCount: count });
  }
  return { chats };
}

/** The latest-version entry of the last distinct bot message in `entries`, or `undefined`. */
function latestBotMessageEntry(entries: readonly JournalEntry[]): JournalEntry | undefined {
  let lastMessageId: number | undefined;
  const latest = new Map<number, JournalEntry>();
  for (const entry of entries) {
    if (entry.direction !== "bot" || entry.kind !== "message") continue;
    lastMessageId = entry.messageId;
    latest.set(entry.messageId, entry);
  }
  return lastMessageId === undefined ? undefined : latest.get(lastMessageId);
}

function findAction(
  rows: readonly (readonly JournalAction[])[],
  label: string | undefined,
  actionId: string | undefined,
): JournalAction | undefined {
  for (const row of rows) {
    for (const action of row) {
      const labelOk = label === undefined || action.label === label;
      const idOk = actionId === undefined || action.id === actionId;
      if (labelOk && idOk && (label !== undefined || actionId !== undefined)) return action;
    }
  }
  return undefined;
}

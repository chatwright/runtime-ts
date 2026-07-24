/**
 * The AI actor {@link Loop}: the observe→propose→validate→act→record cycle
 * that drives a {@link "../goal/campaign.js".CampaignState}'s tasks through a
 * conversation using a pluggable {@link "./provider.js".Provider}. Ported
 * faithfully from the Go runtime's `actor/loop.go`.
 *
 * @remarks
 * Every safety property lives here, never in a provider: budgets and stop
 * reasons come from {@link "../goal/campaign.js".CampaignState}, click
 * proposals are checked with
 * {@link "../observe/engine.js".ObserveEngine.validate}, and an invalid
 * proposal is recorded and re-prompted, never silently acted on. The loop
 * acts through a narrow {@link Actuator} seam and reads back the bot's reply
 * through the same subscribe-driven journal primitives the deterministic
 * scenario verbs use — no busy-polling.
 */

import type { JournalAction } from "../journal/journal.js";
import type { Session } from "../session/session.js";
import type { PlatformUser } from "../platform/codec.js";
import { waitForCondition, nthOutboundMessage, latestEntryForMessage } from "../expect/wait.js";
import { ObserveEngine } from "../observe/engine.js";
import { observedBotEffect } from "../observe/effect.js";
import type { Observation } from "../observe/observe.js";
import { CampaignState } from "../goal/campaign.js";
import { GoalError } from "../goal/errors.js";
import { effectiveContentRules, type Goal, type Task } from "../goal/goal.js";
import { checkContentRules, isEmptyContentRules } from "../goal/content-rules.js";
import type { Budgets } from "../goal/budgets.js";
import type { StopReason, TaskStatus } from "../goal/status.js";
import { isTerminal } from "../goal/status.js";
import type { Prompt, Proposal, Provider } from "./provider.js";
import type { ActionOutcome, ActionOutcomeKind, LoopEvent, ValidationOutcome } from "./loop-event.js";

/**
 * A raw, platform-native bot message the {@link Actuator} reads back — the
 * subset the loop needs to resolve a click's opaque action to a real callback
 * datum (row/col grid) and to track version for edit detection.
 */
export interface ActuatorMessage {
  readonly messageId: number;
  readonly version: number;
  readonly actions: readonly (readonly JournalAction[])[];
}

/**
 * The narrow seam the loop acts through: submit a user action and read back
 * the bot's raw reply. This is deliberately the only place the loop ever sees
 * a platform-native message id or callback datum — a provider never does.
 *
 * @remarks
 * `waitForMessage`/`waitForEdit` resolve to `undefined` on timeout (the twin
 * of Go's `(*Message, false)`). {@link SessionActuator} implements this over
 * a {@link "../session/session.js".Session}.
 */
export interface Actuator {
  submitText(chatId: number, user: PlatformUser, text: string): void;
  submitClick(chatId: number, user: PlatformUser, data: string, targetMessageId: number): void;
  waitForMessage(chatId: number, consumed: number, timeoutMs: number): Promise<ActuatorMessage | undefined>;
  waitForEdit(chatId: number, messageId: number, afterVersion: number, timeoutMs: number): Promise<ActuatorMessage | undefined>;
}

/**
 * An {@link Actuator} over a running {@link "../session/session.js".Session}.
 * Submits through `Session.submitText`/`submitClick`; waits with the shared
 * subscribe-driven {@link "../expect/wait.js".waitForCondition}, never a poll.
 *
 * @remarks
 * Like the Go runtime's synchronous webhook delivery, this assumes the
 * bot-under-test reacts to a submitted update before control returns — so the
 * journal is settled by the time the loop re-observes.
 */
export class SessionActuator implements Actuator {
  constructor(private readonly session: Session) {}

  submitText(chatId: number, user: PlatformUser, text: string): void {
    this.session.submitText(chatId, user, text);
  }

  submitClick(chatId: number, user: PlatformUser, data: string, targetMessageId: number): void {
    this.session.submitClick(chatId, user, data, targetMessageId);
  }

  async waitForMessage(chatId: number, consumed: number, timeoutMs: number): Promise<ActuatorMessage | undefined> {
    const journal = this.session.journal(chatId);
    try {
      const entry = await waitForCondition(
        journal,
        () => nthOutboundMessage(journal.entries(), consumed),
        timeoutMs,
        () => new Error("actor: waitForMessage timed out"),
      );
      return { messageId: entry.messageId, version: entry.version, actions: entry.actions ?? [] };
    } catch {
      return undefined;
    }
  }

  async waitForEdit(chatId: number, messageId: number, afterVersion: number, timeoutMs: number): Promise<ActuatorMessage | undefined> {
    const journal = this.session.journal(chatId);
    try {
      const entry = await waitForCondition(
        journal,
        () => {
          const latest = latestEntryForMessage(journal.entries(), messageId);
          return latest && latest.version > afterVersion ? latest : undefined;
        },
        timeoutMs,
        () => new Error("actor: waitForEdit timed out"),
      );
      return { messageId: entry.messageId, version: entry.version, actions: entry.actions ?? [] };
    } catch {
      return undefined;
    }
  }
}

/** Phase a {@link ProgressSnapshot} was emitted at. */
export type ProgressPhase = "task-started" | "iteration" | "task-ended";

/** One goal.Budgets dimension's consumption as a fraction of its maximum (`0` when unbudgeted). */
export interface BudgetBurn {
  readonly steps: number;
  readonly duration: number;
  readonly cost: number;
  readonly repeatedFailures: number;
}

/** One derived, point-in-time report of a {@link Loop}'s progress through its current task. */
export interface ProgressSnapshot {
  readonly phase: ProgressPhase;
  readonly goalId: string;
  readonly taskId: string;
  readonly taskIndex: number;
  readonly taskCount: number;
  readonly tasksCompleted: number;
  readonly iteration: number;
  readonly budgets: Budgets;
  readonly burn: BudgetBurn;
  readonly nonProgressStreak: number;
  readonly retryCounts: Readonly<Record<string, number>>;
  readonly stopped: boolean;
  readonly stopReason: StopReason | "";
}

/** Configures a {@link Loop}. */
export interface LoopConfig {
  /** The chat the loop drives, as passed to the {@link Actuator}. */
  readonly chatId: number;
  /** The user the loop acts as. */
  readonly user: PlatformUser;
  /** Bounds how many recent loop events feed each prompt's history. Defaults to 10 if `<= 0`/absent. */
  readonly historyWindow?: number;
  /** How many consecutive invalid-or-no-effect proposals the loop tolerates for one task before aborting the campaign. Defaults to 3. */
  readonly nonProgressLimit?: number;
  /** Bounds how long the loop waits, after acting, for the platform's raw reply. Defaults to 5000ms. */
  readonly actWaitTimeoutMs?: number;
  /** The loop's clock (epoch ms), stamped onto every loop event. Pass the same clock as the campaign's. */
  readonly now: () => number;
  /** Turns off retention of every observation the loop produces (on by default). */
  readonly disableObservationRetention?: boolean;
  /** Turns off the overshoot probe (on by default). */
  readonly disableOvershootProbe?: boolean;
  /** Called once per iteration and at each task-start/task-end boundary. Pure, derived reporting — never added to events, a report or a bundle. */
  readonly onProgress?: (snapshot: ProgressSnapshot) => void;
}

/** What one {@link Loop.runTask} call produced. */
export interface TaskResult {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** `true` if the whole campaign had stopped by the time `runTask` returned. */
  readonly stopped: boolean;
  /** `true` if this task's run ended via the loop's own non-progress detection (then `stopped` is also `true`). */
  readonly nonProgress: boolean;
}

const DEFAULT_HISTORY_WINDOW = 10;
const DEFAULT_NON_PROGRESS_LIMIT = 3;
const DEFAULT_ACT_WAIT_TIMEOUT_MS = 5000;

/** The internal per-act outcome `actOn` returns. */
interface ActResult {
  readonly progressed: boolean;
  readonly action: ActionOutcome;
  readonly validation?: ValidationOutcome;
  readonly postObs?: Observation;
}

/**
 * Drives a {@link "../goal/campaign.js".CampaignState}'s tasks through the
 * observe-plan-act-validate cycle. Not safe for concurrent use: drive one
 * campaign from one caller.
 */
export class Loop {
  readonly #provider: Provider;
  readonly #engine: ObserveEngine;
  readonly #actuator: Actuator;
  readonly #campaign: CampaignState;
  readonly #goal: Goal;
  readonly #tasks = new Map<string, Task>();

  readonly #chatId: number;
  readonly #user: PlatformUser;
  readonly #historyWindow: number;
  readonly #nonProgressLimit: number;
  readonly #actWaitTimeoutMs: number;
  readonly #now: () => number;
  readonly #retainObservations: boolean;
  readonly #overshootProbe: boolean;
  readonly #onProgress?: (snapshot: ProgressSnapshot) => void;

  readonly #events: LoopEvent[] = [];
  #consumedBotMessages = 0;
  #lastBotMessage: ActuatorMessage | undefined;
  readonly #observations = new Map<number, Observation>();

  constructor(
    provider: Provider,
    engine: ObserveEngine,
    actuator: Actuator,
    campaign: CampaignState,
    goalDef: Goal,
    config: LoopConfig,
  ) {
    if (typeof config.now !== "function") throw new Error("actor: Loop: config.now is not a function");
    this.#provider = provider;
    this.#engine = engine;
    this.#actuator = actuator;
    this.#campaign = campaign;
    this.#goal = goalDef;
    for (const task of goalDef.tasks) this.#tasks.set(task.id, task);

    this.#chatId = config.chatId;
    this.#user = config.user;
    this.#historyWindow = config.historyWindow && config.historyWindow > 0 ? config.historyWindow : DEFAULT_HISTORY_WINDOW;
    this.#nonProgressLimit =
      config.nonProgressLimit && config.nonProgressLimit > 0 ? config.nonProgressLimit : DEFAULT_NON_PROGRESS_LIMIT;
    this.#actWaitTimeoutMs =
      config.actWaitTimeoutMs && config.actWaitTimeoutMs > 0 ? config.actWaitTimeoutMs : DEFAULT_ACT_WAIT_TIMEOUT_MS;
    this.#now = config.now;
    this.#retainObservations = !config.disableObservationRetention;
    this.#overshootProbe = !config.disableOvershootProbe;
    this.#onProgress = config.onProgress;
  }

  /** A detached copy of every loop event recorded so far, across every task. */
  events(): LoopEvent[] {
    return [...this.#events];
  }

  /** A detached map of every observation this loop has produced so far, keyed by sequence (empty when retention is off). */
  observations(): Map<number, Observation> {
    return new Map(this.#observations);
  }

  /**
   * Activates `taskId` (if pending and eligible; a resumed active task is
   * driven as-is) and runs the observe-plan-act-validate cycle until the task
   * reaches a terminal status, the campaign stops, or the loop's own
   * non-progress detection fires.
   */
  async runTask(taskId: string): Promise<TaskResult> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`actor: runTask: unknown task "${taskId}"`);

    const status = this.#campaign.taskStatus(taskId);
    if (status === "pending") {
      this.#campaign.activate(taskId);
    } else if (isTerminal(status)) {
      return { taskId, status, stopped: this.#campaign.stopped(), nonProgress: false };
    }

    let nonProgressStreak = 0;
    let iteration = 0;
    const retryCounts = new Map<ActionOutcomeKind, number>();
    this.#emitProgress(task, "task-started", iteration, nonProgressStreak, retryCounts);

    const endTask = (result: TaskResult): TaskResult => {
      this.#emitProgress(task, "task-ended", iteration, nonProgressStreak, retryCounts);
      return result;
    };

    for (;;) {
      if (this.#campaign.stopped()) {
        return endTask({ taskId, status: this.#campaign.taskStatus(taskId), stopped: true, nonProgress: false });
      }

      const obs = await this.#observeAndSync();
      const prompt = this.#buildPrompt(task, obs);

      let proposal: Proposal;
      let usage;
      try {
        const result = await this.#provider.propose(prompt);
        proposal = result.proposal;
        usage = result.usage;
      } catch (err) {
        this.#events.push({
          index: this.#events.length,
          at: this.#now(),
          taskId,
          observationSequence: obs.sequence,
          proposeError: err instanceof Error ? err.message : String(err),
        });
        throw new Error(`actor: propose: ${err instanceof Error ? err.message : String(err)}`);
      }

      const act = await this.#actOn(task, obs, proposal);
      this.#events.push({
        index: this.#events.length,
        at: this.#now(),
        taskId,
        observationSequence: obs.sequence,
        proposal,
        usage,
        validation: act.validation,
        action: act.action,
      });
      iteration++;
      retryCounts.set(act.action.kind, (retryCounts.get(act.action.kind) ?? 0) + 1);

      ignoreStopped(() => this.#campaign.recordStep());
      if (usage.cost !== undefined) ignoreStopped(() => this.#campaign.recordCost(usage!.cost!));
      if (act.action.kind === "resolution-failed") ignoreStopped(() => this.#campaign.recordFailure(taskId));

      if (act.action.kind === "task-completed" || act.action.kind === "task-given-up") {
        this.#emitProgress(task, "iteration", iteration, nonProgressStreak, retryCounts);
        return endTask({ taskId, status: this.#campaign.taskStatus(taskId), stopped: this.#campaign.stopped(), nonProgress: false });
      }

      if (act.action.kind === "executed" && task.criteria !== undefined && act.postObs !== undefined) {
        const met = await task.criteria(act.postObs);
        if (met) {
          ignoreStopped(() => this.#campaign.completeByEvidence(taskId));
          if (this.#overshootProbe) await this.#probeOvershoot(task, act.postObs);
          this.#emitProgress(task, "iteration", iteration, nonProgressStreak, retryCounts);
          return endTask({ taskId, status: this.#campaign.taskStatus(taskId), stopped: this.#campaign.stopped(), nonProgress: false });
        }
      }

      if (act.progressed) {
        nonProgressStreak = 0;
      } else {
        nonProgressStreak++;
      }
      this.#emitProgress(task, "iteration", iteration, nonProgressStreak, retryCounts);
      if (!act.progressed && nonProgressStreak >= this.#nonProgressLimit) {
        ignoreStopped(() => this.#campaign.abort());
        return endTask({ taskId, status: this.#campaign.taskStatus(taskId), stopped: true, nonProgress: true });
      }
    }
  }

  /**
   * Repeatedly runs {@link Loop.runTask} for every eligible task (in declared
   * order) until no task is eligible or the campaign has stopped.
   */
  async runCampaign(): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    for (;;) {
      if (this.#campaign.stopped()) return results;
      const taskId = this.#nextEligibleTask();
      if (taskId === undefined) return results;
      results.push(await this.runTask(taskId));
    }
  }

  #nextEligibleTask(): string | undefined {
    for (const task of this.#goal.tasks) {
      try {
        if (this.#campaign.eligible(task.id)) return task.id;
      } catch {
        // unknown task — skip
      }
    }
    return undefined;
  }

  #buildPrompt(task: Task, obs: Observation): Prompt {
    const start = Math.max(0, this.#events.length - this.#historyWindow);
    return {
      goalId: this.#goal.id,
      goalTitle: this.#goal.title ?? "",
      goalDescription: this.#goal.description,
      constraints: this.#goal.constraints,
      taskId: task.id,
      taskTitle: task.title,
      taskSuccessCriteria: task.successCriteria,
      observation: obs,
      history: this.#events.slice(start),
    };
  }

  async #observeAndSync(): Promise<Observation> {
    const obs = this.#engine.observe();
    if (this.#retainObservations) this.#observations.set(obs.sequence, obs);
    await this.#refreshRawBotMessage(obs);
    return obs;
  }

  async #refreshRawBotMessage(obs: Observation): Promise<void> {
    let latestBot: Observation["messages"][number] | undefined;
    let botCount = 0;
    for (const message of obs.messages) {
      if (message.actor === "bot") {
        botCount++;
        latestBot = message;
      }
    }

    while (this.#consumedBotMessages < botCount) {
      const msg = await this.#actuator.waitForMessage(this.#chatId, this.#consumedBotMessages, this.#actWaitTimeoutMs);
      if (msg === undefined) {
        throw new Error(
          `actor: expected bot message #${this.#consumedBotMessages + 1} to already be journaled, but waitForMessage timed out`,
        );
      }
      this.#consumedBotMessages++;
      this.#lastBotMessage = msg;
    }

    if (this.#lastBotMessage !== undefined && latestBot !== undefined && latestBot.version > this.#lastBotMessage.version) {
      const msg = await this.#actuator.waitForEdit(this.#chatId, this.#lastBotMessage.messageId, this.#lastBotMessage.version, this.#actWaitTimeoutMs);
      if (msg === undefined) {
        throw new Error(
          `actor: expected message ${this.#lastBotMessage.messageId} to have been edited to version ${latestBot.version}, but waitForEdit timed out`,
        );
      }
      this.#lastBotMessage = msg;
    }
  }

  #resolveClickTarget(label: string): { row: number; col: number } | undefined {
    if (this.#lastBotMessage === undefined) return undefined;
    const rows = this.#lastBotMessage.actions;
    for (let row = 0; row < rows.length; row++) {
      const cols = rows[row]!;
      for (let col = 0; col < cols.length; col++) {
        if (cols[col]!.label === label) return { row, col };
      }
    }
    return undefined;
  }

  async #actOn(task: Task, obs: Observation, proposal: Proposal): Promise<ActResult> {
    const taskId = task.id;
    switch (proposal.kind) {
      case "task-done": {
        if (task.criteria !== undefined) {
          const met = await task.criteria(obs);
          if (!met) {
            return {
              progressed: false,
              action: { kind: "skipped-invalid", detail: "task-done proposed before evidence-defined criteria are met" },
            };
          }
        }
        try {
          this.#campaign.complete(taskId);
        } catch (err) {
          return { progressed: false, action: { kind: "resolution-failed", detail: errMessage(err) } };
        }
        return { progressed: true, action: { kind: "task-completed" } };
      }

      case "give-up": {
        try {
          this.#campaign.fail(taskId);
        } catch (err) {
          return { progressed: false, action: { kind: "resolution-failed", detail: errMessage(err) } };
        }
        return { progressed: true, action: { kind: "task-given-up" } };
      }

      case "send-text": {
        const text = proposal.text ?? "";
        if (text.trim() === "") {
          return { progressed: false, action: { kind: "skipped-invalid", detail: "empty text proposal" } };
        }
        const rules = effectiveContentRules(this.#goal, task);
        if (!isEmptyContentRules(rules)) {
          const { ok, reason } = checkContentRules(rules, text);
          if (!ok) {
            return { progressed: false, action: { kind: "blocked-constraint-violation", detail: reason } };
          }
        }
        this.#actuator.submitText(this.#chatId, this.#user, text);
        const { effect, fresh } = await this.#observedEffect(obs);
        return {
          progressed: effect,
          action: { kind: effect ? "executed" : "executed-no-effect" },
          postObs: fresh,
        };
      }

      case "click": {
        const result = this.#engine.validate({
          observationSequence: proposal.observationSequence ?? 0,
          actionId: proposal.actionId ?? "",
        });
        const validation: ValidationOutcome = { checked: true, verdict: result.verdict, reason: result.reason };
        if (result.verdict !== "fresh") {
          return { progressed: false, action: { kind: "skipped-invalid", detail: result.reason }, validation };
        }
        const target = this.#resolveClickTarget(result.current!.label);
        if (target === undefined) {
          return {
            progressed: false,
            action: { kind: "resolution-failed", detail: `no action labelled "${result.current!.label}" found on the current message` },
            validation,
          };
        }
        const data = this.#lastBotMessage!.actions[target.row]![target.col]!.id;
        const targetMessageId = this.#lastBotMessage!.messageId;
        this.#actuator.submitClick(this.#chatId, this.#user, data, targetMessageId);
        const { effect, fresh } = await this.#observedEffect(obs);
        return { progressed: effect, action: { kind: effect ? "executed" : "executed-no-effect" }, validation, postObs: fresh };
      }

      default:
        return { progressed: false, action: { kind: "skipped-invalid", detail: `unknown proposal kind ${String(proposal.kind)}` } };
    }
  }

  async #observedEffect(preAction: Observation): Promise<{ effect: boolean; fresh: Observation }> {
    const fresh = await this.#observeAndSync();
    return { effect: observedBotEffect(preAction, fresh), fresh };
  }

  async #probeOvershoot(task: Task, obs: Observation): Promise<void> {
    const prompt = this.#buildPrompt(task, obs);
    try {
      const { proposal, usage } = await this.#provider.propose(prompt);
      this.#events.push({
        index: this.#events.length,
        at: this.#now(),
        taskId: task.id,
        observationSequence: obs.sequence,
        proposal,
        usage,
        action: { kind: "overshoot-probe", detail: "requested after evidence-defined completion; recorded, never executed" },
      });
    } catch (err) {
      this.#events.push({
        index: this.#events.length,
        at: this.#now(),
        taskId: task.id,
        observationSequence: obs.sequence,
        proposeError: errMessage(err),
      });
    }
  }

  #emitProgress(
    task: Task,
    phase: ProgressPhase,
    iteration: number,
    nonProgressStreak: number,
    retryCounts: Map<ActionOutcomeKind, number>,
  ): void {
    if (this.#onProgress === undefined) return;

    const snapshot = this.#campaign.snapshot();
    let taskIndex = 0;
    let tasksCompleted = 0;
    this.#goal.tasks.forEach((t, i) => {
      if (t.id === task.id) taskIndex = i + 1;
      if (snapshot.statuses[t.id] === "completed") tasksCompleted++;
    });

    const budgets = this.#goal.budgets ?? {};
    const burn: BudgetBurn = {
      steps: burnFraction(snapshot.steps, budgets.maxSteps ?? 0),
      duration: burnFraction(snapshot.elapsedMs, budgets.maxDurationMs ?? 0),
      cost: budgets.maxCost !== undefined ? burnFraction(snapshot.cost, budgets.maxCost) : 0,
      repeatedFailures: burnFraction(snapshot.failures[task.id] ?? 0, budgets.maxRepeatedFailures ?? 0),
    };

    this.#onProgress({
      phase,
      goalId: this.#goal.id,
      taskId: task.id,
      taskIndex,
      taskCount: this.#goal.tasks.length,
      tasksCompleted,
      iteration,
      budgets,
      burn,
      nonProgressStreak,
      retryCounts: Object.fromEntries(retryCounts),
      stopped: snapshot.stopped,
      stopReason: snapshot.stopReason,
    });
  }
}

function burnFraction(consumed: number, max: number): number {
  return max <= 0 ? 0 : consumed / max;
}

function ignoreStopped(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof GoalError && err.code === "campaign-stopped") return;
    throw err;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

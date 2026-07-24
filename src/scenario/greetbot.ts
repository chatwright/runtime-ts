/**
 * The built-in greetbot scenario — the dogfood proof — ported from the Go
 * runtime's `arena/scenario.go` (`GreetbotScenario`/`greetbotGoal`/
 * `verifyGreetbotJournal`).
 *
 * @remarks
 * The goal: send `/start`, click the action labelled exactly `"English"`,
 * recognise the in-place edit to `"Howdy stranger"`, then send a free-text
 * acknowledgement. Budgets: `maxSteps` 12. A deterministic journal re-check
 * ({@link verifyGreetbotJournal}) re-derives completion independently of the
 * actor's own task-done claim (evidence over claims).
 *
 * The scenario's provider is deterministic and zero-network. It is NOT a fixed
 * {@link "../actor/scripted-provider.js".ScriptedProvider}: the click step
 * targets an opaque {@link "../observe/observe.js".AvailableAction.id} only
 * known once the picker is observed, so — exactly as the Go runtime's
 * `ScriptedProvider` doc advises for opaque ids — this uses a thin
 * observation-driven policy provider instead.
 */

import type { JournalEntry } from "../journal/journal.js";
import type { PlatformUser } from "../platform/codec.js";
import type { Session } from "../session/session.js";
import type { Prompt, ProposeResult, Provider, Usage } from "../actor/provider.js";
import type { Goal } from "../goal/goal.js";
import type { Assertion } from "../deterministic/assertions.js";
import type { AIGoalPart, Run, VerifyResult } from "../run/run.js";
import type { RegisteredScenario } from "./scenario.js";

/** The single task id greetbot's goal declares. */
export const GREETBOT_TASK_ID = "language-onboarding";
/** Greetbot's exact reply text once `"English"` is picked — the deterministic signal {@link verifyGreetbotJournal} looks for. */
export const ENGLISH_GREETING = "Howdy stranger";
/** The chat the greetbot scenario runs in. */
export const GREETBOT_CHAT_ID = 42;
/** The user the greetbot scenario acts as. */
export const GREETBOT_USER: PlatformUser = { id: 7, firstName: "Arena" };
/** The roster actor id that drives the greetbot loop. */
export const GREETBOT_ACTOR_ID = "arena";

/** The greetbot scenario's registry entry — enough to validate a manifest reference without loading this module's code. */
export const GREETBOT_SCENARIO: RegisteredScenario = {
  id: "greetbot-language-onboarding",
  version: "v1",
  title: "Complete language onboarding and acknowledge the greeting",
  capabilities: ["ai-goal"],
  cases: ["default"],
};

/** The greetbot goal (single task, `maxSteps` 12, `maxDuration` 4 minutes). */
export function greetbotGoal(): Goal {
  return {
    id: "language-onboarding-arena",
    title: "Complete language onboarding and acknowledge the greeting",
    tasks: [
      {
        id: GREETBOT_TASK_ID,
        title: "Complete language onboarding",
        successCriteria:
          'Send "/start" as text to begin the conversation. Wait for the bot\'s language picker message, which ' +
          'carries labelled available actions. Click the action labelled exactly "English" (a click proposal, using ' +
          "its listed action id) — do not send free text for this step, and do not click any other label. After the " +
          "bot's greeting message changes (it is edited in place to an English greeting), send one short text message " +
          'acknowledging the greeting (for example "Thanks!"). Only once you have sent that acknowledgement should you ' +
          "declare the task done.",
      },
    ],
    budgets: { maxSteps: 12, maxDurationMs: 4 * 60_000 },
  };
}

/**
 * A deterministic, zero-network provider driving the greetbot happy path. It
 * reads the current observation to decide the next action, so the opaque
 * `"English"` action id is resolved at propose-time rather than hard-coded.
 */
export class GreetbotProvider implements Provider {
  readonly #usage: Usage;

  constructor(usage: Usage = { model: "greetbot-policy", inputTokens: 8, outputTokens: 3, latencyMs: 0 }) {
    this.#usage = usage;
  }

  async propose(prompt: Prompt): Promise<ProposeResult> {
    const messages = prompt.observation.messages;
    const startSent = messages.some((m) => m.actor === "user" && m.text === "/start");
    const greetingShown = messages.some((m) => m.actor === "bot" && m.text === ENGLISH_GREETING);
    const ackSent = messages.some((m) => m.actor === "user" && m.text === "Thanks!");
    const english = findEnglishAction(messages);

    if (!startSent) {
      return this.#result({ kind: "send-text", text: "/start", rationale: "begin the conversation" });
    }
    if (english !== undefined && !greetingShown) {
      return this.#result({
        kind: "click",
        actionId: english,
        observationSequence: prompt.observation.sequence,
        rationale: "pick the English language option",
      });
    }
    if (greetingShown && !ackSent) {
      return this.#result({ kind: "send-text", text: "Thanks!", rationale: "acknowledge the greeting" });
    }
    return this.#result({ kind: "task-done", rationale: "greeting acknowledged" });
  }

  #result(proposal: ProposeResult["proposal"]): ProposeResult {
    return { proposal, usage: this.#usage };
  }
}

function findEnglishAction(messages: Prompt["observation"]["messages"]): string | undefined {
  for (const message of messages) {
    for (const action of message.actions) {
      if (action.label === "English") return action.id;
    }
  }
  return undefined;
}

/**
 * The deterministic, journal-level re-check of what actually happened —
 * independent of whether the actor declared the task done (evidence over
 * claims). Looks for the three discriminating steps: the user sent `/start`, a
 * bot message was edited to the English greeting (which only happens if
 * `"English"` was clicked), and a further user text followed it.
 */
export function verifyGreetbotJournal(entries: readonly JournalEntry[]): VerifyResult {
  let sawStart = false;
  let greetingChanged = false;
  let ackAfterGreet = false;
  let greetIdx = -1;

  entries.forEach((entry, i) => {
    if (entry.kind !== "message") return;
    if (entry.direction === "user") {
      if (entry.text === "/start") sawStart = true;
      if (greetIdx >= 0 && entry.text.trim() !== "" && entry.text !== "/start") ackAfterGreet = true;
    } else if (entry.direction === "bot") {
      if (greetIdx < 0 && entry.version > 0 && entry.text === ENGLISH_GREETING) {
        greetingChanged = true;
        greetIdx = i;
      }
    }
  });

  if (sawStart && greetingChanged && ackAfterGreet) {
    return { verified: true, detail: "started, clicked English, acknowledged — all journal-verified" };
  }
  const missing: string[] = [];
  if (!sawStart) missing.push("never sent /start");
  if (!greetingChanged) missing.push("never got the English greeting (wrong/no click)");
  if (!ackAfterGreet) missing.push("never sent an acknowledgement after the greeting changed");
  return { verified: false, detail: "journal evidence incomplete: " + missing.join("; ") };
}

/**
 * Deterministic assertions over the finished greetbot journal — the same
 * discriminating facts {@link verifyGreetbotJournal} checks, expressed through
 * the serialisable {@link "../deterministic/assertions.js".Assertion} model so
 * the evaluator itself is exercised.
 */
export function greetbotAssertions(): Assertion[] {
  return [
    { kind: "expects-action", botTurn: 1, label: "English" },
    { kind: "edited", botTurn: 1 },
    { kind: "text-equals", botTurn: 1, text: ENGLISH_GREETING },
    { kind: "text-equals", botTurn: 2, text: ENGLISH_GREETING },
  ];
}

/** Options for {@link buildGreetbotRun}. */
export interface GreetbotRunOptions {
  /** The run's clock (epoch ms). */
  readonly now: () => number;
  /** Overrides the actor id (defaults to {@link GREETBOT_ACTOR_ID}). */
  readonly actorId?: string;
  /** Overrides the provider (defaults to a fresh {@link GreetbotProvider}). */
  readonly provider?: Provider;
}

/** Builds a single-part ai-goal {@link Run} for the greetbot scenario over `session`. */
export function buildGreetbotRun(session: Session, options: GreetbotRunOptions): Run {
  const part: AIGoalPart = {
    kind: "ai-goal",
    id: GREETBOT_TASK_ID,
    title: "Complete language onboarding",
    actorId: options.actorId ?? GREETBOT_ACTOR_ID,
    chatId: GREETBOT_CHAT_ID,
    user: GREETBOT_USER,
    goal: greetbotGoal(),
    provider: options.provider ?? new GreetbotProvider(),
    verify: (entries) => verifyGreetbotJournal(entries),
  };
  return {
    id: "greetbot-run",
    environment: { session, chatIds: [GREETBOT_CHAT_ID], now: options.now },
    parts: [part],
  };
}

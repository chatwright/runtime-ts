/**
 * A DATA-DRIVEN, serialisable deterministic assertion model over a chat's
 * journal.
 *
 * @remarks
 * The Go runtime's deterministic side is a fluent code DSL
 * (`runtime-go/cw/expect.go`: `Text`/`TextContains`/`TextMatches`/
 * `ExpectAction`/`ExpectEdited`/`Within`). This module preserves those
 * SEMANTICS but expresses each check as a plain serialisable object, so a
 * scenario can be authored, transported and replayed as data (per the
 * portable-scenario-documents feature) rather than as compiled code.
 *
 * Each assertion evaluates against the journal to a
 * {@link AssertionVerdict} — `"pass"`, `"fail"`, or `"unverified"` — with a
 * human-readable diagnostic naming the expected value, the actual value and
 * which turn it concerned. Side-effect assertions (`data-state`, the DTQL
 * family) evaluate to `"unverified"` in the browser runtime with a
 * browser-limitation reason; a companion-server verifier can be plugged in
 * through {@link EvaluateOptions.verifier}.
 */

import type { JournalAction, JournalEntry } from "../journal/journal.js";

/** A serialisable assertion's kind — a string-literal union, never an integer enum. */
export type AssertionKind =
  | "text-equals"
  | "text-contains"
  | "text-matches"
  | "expects-action"
  | "edited"
  | "within"
  | "data-state";

/** Fields shared by every assertion that targets one bot message. */
interface TargetedAssertion {
  /**
   * The 1-based ordinal of the distinct bot message this assertion concerns
   * (the "turn"). Omitted targets the most recent bot message.
   */
  readonly botTurn?: number;
}

/** Asserts a bot message's text equals `text` exactly. */
export interface TextEqualsAssertion extends TargetedAssertion {
  readonly kind: "text-equals";
  readonly text: string;
}

/** Asserts a bot message's text contains `substring`. */
export interface TextContainsAssertion extends TargetedAssertion {
  readonly kind: "text-contains";
  readonly substring: string;
}

/** Asserts a bot message's text matches the regular expression `pattern`. */
export interface TextMatchesAssertion extends TargetedAssertion {
  readonly kind: "text-matches";
  readonly pattern: string;
}

/** Asserts a bot message carries an interactive action matching `label` and/or `actionId`. */
export interface ExpectsActionAssertion extends TargetedAssertion {
  readonly kind: "expects-action";
  readonly label?: string;
  readonly actionId?: string;
}

/** Asserts a bot message was edited in place (its version advanced past 0). */
export interface EditedAssertion extends TargetedAssertion {
  readonly kind: "edited";
}

/** Asserts a bot message arrived within `ms` of the preceding inbound action (latency bound). */
export interface WithinAssertion extends TargetedAssertion {
  readonly kind: "within";
  readonly ms: number;
}

/**
 * A side-effect (application-state / DTQL) assertion. Not verifiable by the
 * browser runtime alone — evaluates to `"unverified"` unless an
 * {@link EvaluateOptions.verifier} resolves it.
 */
export interface DataStateAssertion {
  readonly kind: "data-state";
  readonly name: string;
  readonly holder?: string;
  readonly query?: string;
}

/** Any serialisable assertion. */
export type Assertion =
  | TextEqualsAssertion
  | TextContainsAssertion
  | TextMatchesAssertion
  | ExpectsActionAssertion
  | EditedAssertion
  | WithinAssertion
  | DataStateAssertion;

/** The deterministic outcome of evaluating one {@link Assertion}. */
export type AssertionVerdict = "pass" | "fail" | "unverified";

/** One assertion's evaluation result. */
export interface AssertionOutcome {
  readonly kind: AssertionKind;
  readonly verdict: AssertionVerdict;
  /** Human-readable explanation: expected vs actual, and which turn. Always set. */
  readonly diagnostic: string;
  /** The resolved 1-based bot-message turn this concerned, when applicable. */
  readonly botTurn?: number;
}

/** Resolves a side-effect assertion the browser runtime cannot verify itself. */
export type SideEffectVerifier = (assertion: DataStateAssertion) => AssertionOutcome | undefined;

/** Options for {@link evaluateAssertions}. */
export interface EvaluateOptions {
  /** A pluggable verifier for side-effect (`data-state`) assertions — the companion-server seam. */
  readonly verifier?: SideEffectVerifier;
}

/** One distinct bot message, at its latest version, plus where it lives in the journal. */
interface BotMessageView {
  readonly turn: number; // 1-based
  readonly entryIndex: number; // index of the latest-version entry in `entries`
  readonly messageId: number;
  readonly version: number;
  readonly text: string;
  readonly actions: readonly (readonly JournalAction[])[];
}

/**
 * Evaluates every assertion in `assertions` against `entries`, in order,
 * returning one {@link AssertionOutcome} per assertion. Pure: it never drives
 * the chat, starts a bot, or touches a database.
 */
export function evaluateAssertions(
  entries: readonly JournalEntry[],
  assertions: readonly Assertion[],
  options: EvaluateOptions = {},
): AssertionOutcome[] {
  const botMessages = distinctBotMessages(entries);
  return assertions.map((assertion) => evaluateOne(entries, botMessages, assertion, options));
}

function evaluateOne(
  entries: readonly JournalEntry[],
  botMessages: readonly BotMessageView[],
  assertion: Assertion,
  options: EvaluateOptions,
): AssertionOutcome {
  if (assertion.kind === "data-state") {
    const resolved = options.verifier?.(assertion);
    return (
      resolved ?? {
        kind: "data-state",
        verdict: "unverified",
        diagnostic: `data-state assertion "${assertion.name}" requires the companion verification server; the browser runtime cannot verify application state`,
      }
    );
  }

  const target = resolveTarget(botMessages, assertion.botTurn);
  if (target === undefined) {
    return {
      kind: assertion.kind,
      verdict: "fail",
      diagnostic: assertion.botTurn
        ? `expected bot message #${assertion.botTurn}, but only ${botMessages.length} bot message(s) were sent`
        : "expected at least one bot message, but none was sent",
      botTurn: assertion.botTurn,
    };
  }

  switch (assertion.kind) {
    case "text-equals":
      return outcome(
        assertion.kind,
        target.text === assertion.text,
        `expected bot message #${target.turn} text ${quote(assertion.text)}, got ${quote(target.text)}`,
        target.turn,
      );

    case "text-contains":
      return outcome(
        assertion.kind,
        target.text.includes(assertion.substring),
        `expected bot message #${target.turn} text to contain ${quote(assertion.substring)}, got ${quote(target.text)}`,
        target.turn,
      );

    case "text-matches": {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern);
      } catch (err) {
        return {
          kind: assertion.kind,
          verdict: "fail",
          diagnostic: `invalid pattern ${quote(assertion.pattern)}: ${err instanceof Error ? err.message : String(err)}`,
          botTurn: target.turn,
        };
      }
      return outcome(
        assertion.kind,
        re.test(target.text),
        `expected bot message #${target.turn} text to match /${assertion.pattern}/, got ${quote(target.text)}`,
        target.turn,
      );
    }

    case "expects-action": {
      const found = findAction(target.actions, assertion.label, assertion.actionId);
      const wanted =
        assertion.label !== undefined && assertion.actionId !== undefined
          ? `label ${quote(assertion.label)} and id ${quote(assertion.actionId)}`
          : assertion.label !== undefined
            ? `label ${quote(assertion.label)}`
            : `id ${quote(assertion.actionId ?? "")}`;
      return outcome(
        assertion.kind,
        found,
        `expected bot message #${target.turn} to carry an action with ${wanted}; actions: ${JSON.stringify(flattenLabels(target.actions))}`,
        target.turn,
      );
    }

    case "edited":
      return outcome(
        assertion.kind,
        target.version > 0,
        `expected bot message #${target.turn} (id ${target.messageId}) to have been edited in place; version is ${target.version}`,
        target.turn,
      );

    case "within": {
      const latency = latencyMsFor(entries, target.entryIndex);
      return outcome(
        assertion.kind,
        latency <= assertion.ms,
        `expected bot message #${target.turn} within ${assertion.ms}ms; observed ${latency}ms`,
        target.turn,
      );
    }

    default: {
      const _exhaustive: never = assertion;
      return { kind: (_exhaustive as Assertion).kind, verdict: "unverified", diagnostic: "unknown assertion kind" };
    }
  }
}

function outcome(kind: AssertionKind, pass: boolean, diagnostic: string, botTurn: number): AssertionOutcome {
  return { kind, verdict: pass ? "pass" : "fail", diagnostic, botTurn };
}

/** Projects the journal into the distinct bot messages, latest version each, in first-seen order. */
function distinctBotMessages(entries: readonly JournalEntry[]): BotMessageView[] {
  const order: number[] = [];
  const latestIndex = new Map<number, number>();
  entries.forEach((entry, i) => {
    if (entry.direction !== "bot" || entry.kind !== "message") return;
    if (!latestIndex.has(entry.messageId)) order.push(entry.messageId);
    latestIndex.set(entry.messageId, i);
  });
  return order.map((messageId, i) => {
    const index = latestIndex.get(messageId)!;
    const entry = entries[index]!;
    return {
      turn: i + 1,
      entryIndex: index,
      messageId,
      version: entry.version,
      text: entry.text,
      actions: entry.actions ?? [],
    };
  });
}

function resolveTarget(botMessages: readonly BotMessageView[], botTurn: number | undefined): BotMessageView | undefined {
  if (botTurn === undefined) return botMessages[botMessages.length - 1];
  return botMessages[botTurn - 1];
}

function findAction(
  rows: readonly (readonly JournalAction[])[],
  label: string | undefined,
  actionId: string | undefined,
): boolean {
  for (const row of rows) {
    for (const action of row) {
      const labelOk = label === undefined || action.label === label;
      const idOk = actionId === undefined || action.id === actionId;
      if (labelOk && idOk && (label !== undefined || actionId !== undefined)) return true;
    }
  }
  return false;
}

function flattenLabels(rows: readonly (readonly JournalAction[])[]): string[] {
  const flat: string[] = [];
  for (const row of rows) for (const action of row) flat.push(action.label);
  return flat;
}

/** Latency (ms) between a bot entry and the most recent preceding inbound (user) entry, via their `at` timestamps. */
function latencyMsFor(entries: readonly JournalEntry[], botEntryIndex: number): number {
  const botAt = Date.parse(entries[botEntryIndex]!.at);
  for (let i = botEntryIndex - 1; i >= 0; i--) {
    if (entries[i]!.direction === "user") {
      const userAt = Date.parse(entries[i]!.at);
      const delta = botAt - userAt;
      return Number.isFinite(delta) && delta > 0 ? delta : 0;
    }
  }
  return 0;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

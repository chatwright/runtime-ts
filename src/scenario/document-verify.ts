/**
 * The declarative, independent journal re-check `verify` compiles to —
 * ported **byte-for-byte** from `runtime-go`'s `scenario/verify.go`. This is
 * the format's single most parity-sensitive surface: `UNMET_PREFIX` and the
 * `"; "` join are pinned by the format README ("the prefix and join belong
 * to the runtime and are identical in both, so the whole detail string is
 * byte-comparable across runtimes") — see `document-verify.test.ts` for the
 * literal cross-runtime string assertions.
 */

import type { JournalEntry } from "../journal/journal.js";
import type { VerifyResult } from "../run/run.js";
import type { Condition, ConditionField, Document, Verify } from "./document.js";

/**
 * The fixed runtime prefix an unmet {@link VerifyResult}'s `detail` always
 * starts with — pinned as an exported constant, not reconstructed at each
 * call site, so this module and its tests can never drift from
 * `runtime-go`'s identical `scenario.UnmetPrefix`.
 */
export const UNMET_PREFIX = "journal evidence incomplete: ";

// VerifyResult itself is `../run/run.js`'s own `{readonly verified: boolean;
// readonly detail: string}` — the exact shape this module's `evaluate`
// already had to satisfy to plug into `AIGoalPart.verify` (see
// `document-build.ts`). Reusing it here (rather than declaring an
// identically-shaped duplicate) is both DRY and avoids an ambiguous
// `export *` at the package's top level (`src/index.ts` already re-exports
// `run/run.js`'s `VerifyResult`).

interface CompiledCondition {
  readonly field: string;
  readonly op: string;
  readonly values?: readonly string[]; // exact/contains: any-of
  readonly bool?: boolean; // exact on the "edited" field
  readonly regex?: RegExp;
  readonly negate: boolean;
}

interface CompiledExpectation {
  readonly id: string;
  readonly unmetDetail: string;
  readonly all: readonly CompiledCondition[];
}

/**
 * A document's `verify` block, compiled once (regex patterns parsed,
 * condition values decoded) so {@link VerifySpec.evaluate} can run against a
 * journal with no further parsing.
 */
export class VerifySpec {
  readonly #chatDocId: string;
  readonly #metDetail: string;
  readonly #expectations: readonly CompiledExpectation[];

  constructor(chatDocId: string, metDetail: string, expectations: readonly CompiledExpectation[]) {
    this.#chatDocId = chatDocId;
    this.#metDetail = metDetail;
    this.#expectations = expectations;
  }

  /** The doc-local chat id (`Document.chats[*].id`) this spec evaluates against. */
  get chatDocId(): string {
    return this.#chatDocId;
  }

  /**
   * Re-derives a `verify` block's verdict from `entries` — one chat's
   * complete journal history — independent of any actor's own task-done
   * claim (principle 3, "evidence over claims"). Expectations are matched in
   * declared order: expectation N matches the earliest journal entry
   * strictly after the entry expectation N-1 matched — the format README's
   * "Expectations are ordered" rule. All expectations matched yields
   * `verified: true` with `detail` set to the spec's own `metDetail`;
   * otherwise `verified: false` with `detail` set to {@link UNMET_PREFIX}
   * followed by every unmatched expectation's `unmetDetail`, in declared
   * order, joined with `"; "`.
   */
  evaluate(entries: readonly JournalEntry[]): VerifyResult {
    let cursor = -1;
    const unmet: string[] = [];
    for (const exp of this.#expectations) {
      const idx = findMatch(entries, cursor + 1, exp);
      if (idx < 0) {
        unmet.push(exp.unmetDetail);
        continue;
      }
      cursor = idx;
    }
    if (unmet.length === 0) return { verified: true, detail: this.#metDetail };
    return { verified: false, detail: UNMET_PREFIX + unmet.join("; ") };
  }
}

/**
 * Compiles `doc.verify` into a {@link VerifySpec} ready to evaluate, or
 * `undefined` when `doc` declares no `verify` block at all — see the format
 * README's "A document with no verify block is not reported as verified"
 * rule; the caller is what turns an `undefined` spec into the
 * judged-not-verified outcome, this function only reports absence.
 *
 * @remarks
 * Assumes `doc` has already passed `document-validate.ts`'s `validateDocument`:
 * `Condition.field`/`op` vocabulary, the regex subset restriction and
 * `value`'s shape are not re-checked here — a malformed `verify` block
 * reaching this function unvalidated is a caller bug, reported as a plain
 * `Error` rather than a `Report` issue.
 */
export function compileVerify(doc: Document): VerifySpec | undefined {
  if (doc.verify === undefined) return undefined;
  return compileVerifyBlock(doc.verify);
}

/** As {@link compileVerify}, but takes the `verify` block directly (for unit tests that do not need a whole `Document`). */
export function compileVerifyBlock(v: Verify): VerifySpec {
  const expectations: CompiledExpectation[] = v.journal.map((exp) => ({
    id: exp.id,
    unmetDetail: exp.unmetDetail,
    all: exp.all.map((c) => compileCondition(c, exp.id)),
  }));
  return new VerifySpec(v.chat, v.metDetail, expectations);
}

function compileCondition(c: Condition, expectationId: string): CompiledCondition {
  const field = c.field as ConditionField;
  if (field === "edited") {
    if (typeof c.value !== "boolean") {
      throw new Error(`scenario: verify.journal[${expectationId}]: condition on "edited": value must be a boolean`);
    }
    return { field: c.field, op: c.op, bool: c.value, negate: c.negate ?? false };
  }
  if (c.op === "regex") {
    if (typeof c.value !== "string") {
      throw new Error(`scenario: verify.journal[${expectationId}]: regex condition: value must be a string`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(c.value);
    } catch (err) {
      throw new Error(`scenario: verify.journal[${expectationId}]: regex condition: ${errMessage(err)}`);
    }
    return { field: c.field, op: c.op, regex, negate: c.negate ?? false };
  }
  const values = decodeStringOrStringList(c.value, expectationId, c.field);
  return { field: c.field, op: c.op, values, negate: c.negate ?? false };
}

/** Decodes `value` as a single string or an array of strings (any-of) — the shape `exact`/`contains` accept. */
export function decodeStringOrStringList(value: unknown, expectationId: string, field: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`scenario: verify.journal[${expectationId}]: condition on "${field}": value must be a string or an array of strings`);
}

function findMatch(entries: readonly JournalEntry[], from: number, exp: CompiledExpectation): number {
  for (let i = from; i < entries.length; i++) {
    if (matchAll(entries[i]!, exp.all)) return i;
  }
  return -1;
}

function matchAll(entry: JournalEntry, conditions: readonly CompiledCondition[]): boolean {
  return conditions.every((c) => matchCondition(entry, c));
}

function matchCondition(entry: JournalEntry, c: CompiledCondition): boolean {
  let result: boolean;
  if (c.field === "edited") {
    result = entry.version > 0 === c.bool;
  } else {
    const actual = fieldValue(entry, c.field);
    switch (c.op) {
      case "exact":
        result = matchesAny(c.values ?? [], actual, false);
        break;
      case "contains":
        result = matchesAny(c.values ?? [], actual, true);
        break;
      case "regex":
        result = c.regex!.test(actual);
        break;
      default:
        result = false;
    }
  }
  return c.negate ? !result : result;
}

function fieldValue(entry: JournalEntry, field: string): string {
  switch (field) {
    case "kind":
      return entry.kind;
    case "direction":
      return entry.direction;
    case "text":
      return entry.text;
    default:
      return "";
  }
}

function matchesAny(candidates: readonly string[], actual: string, substr: boolean): boolean {
  return candidates.some((c) => (substr ? actual.includes(c) : actual === c));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

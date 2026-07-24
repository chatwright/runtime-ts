/**
 * {@link ContentRules}: machine-checkable, deterministic constraints on what
 * an actor may *say* on the way in (the symmetric half of evidence-defined
 * completion), ported from the Go runtime's `goal/content_rules.go`.
 *
 * @remarks
 * All checks are deterministic — no semantic/NLP judgement. The Go
 * `ContentPredicate`'s `context.Context` parameter is dropped in the browser
 * port; a predicate that needs to fail the check itself throws, mirroring
 * Go's non-nil error return.
 */

/**
 * A custom, deterministic content check beyond {@link ContentRules}' own
 * vocabulary/deny-pattern checks. Returns whether `text` is allowed and, when
 * not, a human-readable reason. Throwing means the check itself failed (not
 * that `text` violated it), surfaced to the loop's caller.
 */
export type ContentPredicate = (text: string) => { ok: boolean; reason: string };

/**
 * Declares deterministic content rules for a task's (or a goal's) send-text
 * proposals. The empty value (`{}`) means "no rule": every text proposal
 * passes. See {@link effectiveContentRules} for how a task's own rules, when
 * non-empty, override its goal's.
 */
export interface ContentRules {
  /**
   * A case-insensitive allowlist of terms: {@link checkContentRules} fails
   * when `text` (lower-cased) contains none of them as a substring. Empty
   * means no vocabulary check. Exact substring matching only, deliberately —
   * this deterministic layer rules out semantic matching.
   */
  readonly vocabulary?: readonly string[];
  /**
   * Regular expressions checked against the proposal's raw (not lower-cased)
   * text; any match blocks it, regardless of vocabulary. Checked BEFORE
   * vocabulary, so a denied pattern is always the reported reason.
   */
  readonly denyPatterns?: readonly RegExp[];
  /** An optional custom deterministic check, run last (after deny-patterns and vocabulary both pass). */
  readonly predicate?: ContentPredicate;
}

/**
 * Reports whether `r` declares no rule at all — the condition
 * {@link effectiveContentRules} uses to decide whether a task's own rules
 * override its goal's.
 */
export function isEmptyContentRules(r: ContentRules): boolean {
  return (
    (r.vocabulary?.length ?? 0) === 0 &&
    (r.denyPatterns?.length ?? 0) === 0 &&
    r.predicate === undefined
  );
}

/**
 * Judges `text` against `r`'s rules, in the fixed order documented on each
 * field (deny-patterns, then vocabulary, then predicate — the first violation
 * found is the one reported). `ok` is `true`, with an empty reason, when `r`
 * is empty or `text` violates none of its rules. A predicate that throws
 * propagates, never meaning `text` violated a rule.
 */
export function checkContentRules(
  r: ContentRules,
  text: string,
): { ok: boolean; reason: string } {
  for (const pattern of r.denyPatterns ?? []) {
    if (pattern.test(text)) {
      return { ok: false, reason: `text matches a denied pattern: ${pattern.source}` };
    }
  }

  const vocabulary = r.vocabulary ?? [];
  if (vocabulary.length > 0) {
    const lower = text.toLowerCase();
    const matched = vocabulary.some(
      (term) => term !== "" && lower.includes(term.toLowerCase()),
    );
    if (!matched) {
      return { ok: false, reason: "text does not contain any allowed vocabulary term" };
    }
  }

  if (r.predicate !== undefined) {
    const { ok, reason } = r.predicate(text);
    if (!ok) return { ok: false, reason };
  }

  return { ok: true, reason: "" };
}

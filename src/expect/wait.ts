/**
 * Subscribe-based waiting over a {@link Journal} — the async twin of
 * `runtime-go`'s `Emulator.WaitForMessage`/`WaitForEdit`
 * (`chatwright/runtime-go/telegram/emulator.go`), ported as an algorithm per
 * decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}.
 *
 * @remarks
 * Go's versions block a goroutine, waking on a per-append condition
 * broadcast and re-scanning the journal on every wake, until either a
 * predicate over the whole journal is satisfied or a `time.After` deadline
 * fires first. There is no goroutine to block here — `waitForCondition`
 * is the same "recompute a predicate over the whole journal on every
 * append, first-check optimistically, then race against a timer" shape,
 * expressed as a `Promise` driven by {@link Journal.subscribe} instead of a
 * condition variable. No polling: the promise only ever does work in
 * response to an actual journal append or the timeout firing.
 */

import type { Journal, JournalEntry } from "../journal/journal.js";

/**
 * Waits for `compute()` — a pure function of `journal`'s current entries —
 * to return a defined result, checking it once immediately (the result may
 * already be sitting in the journal) and then again after every subsequent
 * append, until either it succeeds or `timeoutMs` elapses first. On timeout,
 * rejects with `onTimeout()`'s `Error` (so callers can embed a transcript,
 * mirroring Go's `t.Fatalf` diagnostics).
 */
export function waitForCondition<T>(
  journal: Journal,
  compute: () => T | undefined,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const immediate = compute();
    if (immediate !== undefined) {
      resolve(immediate);
      return;
    }

    let settled = false;
    let unsubscribe: () => void = () => {};

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(onTimeout());
    }, timeoutMs);

    unsubscribe = journal.subscribe(() => {
      if (settled) return;
      const result = compute();
      if (result !== undefined) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      }
    });
  });
}

/**
 * Returns the current (latest-version) state of the `(consumed + 1)`-th
 * distinct bot-sent message in `entries`, in the order those messages were
 * first sent — `undefined` if fewer than `consumed + 1` distinct bot
 * messages have been sent yet. Mirrors Go's `nthOutboundMessageLocked`
 * exactly, including reading the *latest* version of that message (an
 * already-edited message still counts at its current text/actions).
 */
export function nthOutboundMessage(entries: readonly JournalEntry[], consumed: number): JournalEntry | undefined {
  const order: number[] = [];
  const latestById = new Map<number, JournalEntry>();
  for (const entry of entries) {
    if (entry.direction !== "bot" || entry.kind !== "message") continue;
    if (!latestById.has(entry.messageId)) order.push(entry.messageId);
    latestById.set(entry.messageId, entry); // later entries (higher version) overwrite, journal is append-only
  }
  if (consumed >= order.length) return undefined;
  return latestById.get(order[consumed]!);
}

/** Returns the latest (current) journal entry for a bot message, or `undefined` if it was never sent. */
export function latestEntryForMessage(entries: readonly JournalEntry[], messageId: number): JournalEntry | undefined {
  let found: JournalEntry | undefined;
  for (const entry of entries) {
    if (entry.direction === "bot" && entry.kind === "message" && entry.messageId === messageId) {
      found = entry;
    }
  }
  return found;
}

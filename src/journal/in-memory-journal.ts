/**
 * The journal seam's one concrete implementation for this package: an
 * in-memory, append-only {@link Journal} plus the {@link Clock} abstraction
 * every timestamp-producing part of this runtime (journal entries, bundle
 * metadata) is threaded through instead of calling `Date.now()`/`new Date()`
 * directly.
 *
 * @remarks
 * `InMemoryJournal` is deliberately dumb: it stores entries in the order
 * `append` is called, in memory, for the lifetime of the process. It does not
 * itself decide *what* a chat's journal is scoped to — {@link
 * "../session/session.js".Session} owns one `InMemoryJournal` per chat id,
 * mirroring the Go emulator's per-chat view over its single flat journal
 * (`Emulator.Journal(chatID)`), just realised here as one object per chat
 * instead of one filter predicate over a shared slice.
 */

import type { Journal, JournalEntry } from "./journal.js";

/**
 * Produces the current time. Every part of this package that needs "now"
 * (journal entry timestamps, run-bundle `metadata.createdAt`) takes a
 * {@link Clock} instead of calling `Date.now()`/`new Date()` directly, so
 * tests can supply a deterministic or monotonically-advancing clock instead
 * of racing the real one.
 *
 * @remarks
 * `Date.now()` itself is a perfectly fine implementation of a `Clock` (see
 * {@link systemClock}) — the point is only that callers depend on the
 * injected function, never on the global directly.
 */
export type Clock = () => Date;

/**
 * The default {@link Clock}: the real wall clock, via `new Date()`. Used
 * wherever a caller does not supply one of their own.
 */
export const systemClock: Clock = () => new Date();

/**
 * An in-memory {@link Journal}: entries accumulate in append order for the
 * life of this object, and `subscribe` replays nothing retroactively — a new
 * subscriber only observes entries appended after it subscribes, matching
 * the append-only, forward-only nature of the journal itself.
 */
export class InMemoryJournal implements Journal {
  private readonly entryList: JournalEntry[] = [];
  private readonly listeners = new Set<(entry: JournalEntry) => void>();

  append(entry: JournalEntry): void {
    this.entryList.push(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  entries(): readonly JournalEntry[] {
    return this.entryList;
  }

  subscribe(listener: (entry: JournalEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * The journal seam: the append-only, per-chat, versioned-on-edit journal
 * that is ground truth for a run, mirrored from the Go runtime's
 * `platform.JournalEntry` shape.
 *
 * @remarks
 * Decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}
 * names journal + observation as the third seam, "ported as an algorithm
 * from the Go `observe` engine" rather than shared as code — only formats
 * are shared, never libraries. {@link JournalEntry} below is a direct,
 * field-for-field mirror of the Go runtime's journal entry shape as it
 * appears on the wire in
 * {@link https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json | run-bundle v1's `PlatformJournalEntry`},
 * so that a run-bundle producer in this package can converge on that wire
 * shape without a translation layer at every call site.
 *
 * That convergence happens at **bundle-assembly time**, not here: this
 * module's types are the runtime's live, in-memory journal shape. They are
 * deliberately declared independently of the generated run-bundle types
 * (per decision 0012, "Shared contracts are language-independent formats,
 * never code") — assembling a `formats/run-bundle/v1` document from a
 * {@link Journal}'s entries is future work, out of scope for this
 * scaffold.
 *
 * The observation projection that correlates journal entries into
 * user-visible conversation state (the Go `observe` engine's output,
 * `ObserveObservation` in the run-bundle schema) is not scaffolded here —
 * it is part of research item I-66.
 */

/**
 * Who produced a journal entry.
 */
export type JournalDirection = "user" | "bot";

/**
 * What kind of thing a journal entry records.
 *
 * @remarks
 * `"message"` and `"action"` are self-explanatory; `"uncaptured"` records
 * that something happened which the current platform codec's fidelity
 * could not represent losslessly — an honesty marker (decision 0008), not
 * an error.
 */
export type JournalEntryKind = "message" | "action" | "uncaptured";

/**
 * One clickable action attached to a message (for example an inline
 * keyboard button), mirroring the run-bundle schema's `PlatformAction`.
 */
export interface JournalAction {
  readonly label: string;
  readonly id: string;
  readonly url: string;
}

/**
 * A single append-only journal entry.
 *
 * @remarks
 * Field-for-field mirror of run-bundle v1's `PlatformJournalEntry`:
 *
 * - `messageId` / `refMessageId` — this entry's identity and, for an edit,
 *   the identity of the entry it revises.
 * - `version` — increments each time a message already in the journal is
 *   edited in place; the journal never deletes, it only appends new
 *   versions.
 * - `actions` — rows of {@link JournalAction}, mirroring an inline
 *   keyboard's row/column layout; `undefined` when the entry carries no
 *   actions.
 * - `method` — the platform method name the entry originated from (bot
 *   entries only), such as `"sendMessage"`.
 * - `fromId` — the platform-native sender id.
 */
export interface JournalEntry {
  readonly direction: JournalDirection;
  readonly kind: JournalEntryKind;
  readonly messageId: number;
  readonly refMessageId: number;
  readonly version: number;
  readonly text: string;
  readonly actions?: readonly (readonly JournalAction[])[];
  readonly method: string;
  readonly at: string;
  readonly fromId: number;
}

/**
 * An append-only journal for one chat.
 *
 * @remarks
 * `append` is the only way entries enter the journal — there is
 * deliberately no update or delete method; an edit is recorded as a new
 * entry referencing `refMessageId` with an incremented `version`, per the
 * Go runtime's proven journal semantics. `subscribe` lets the player
 * component (research item I-66) render a live, in-progress journal
 * instead of waiting for a finished run bundle.
 */
export interface Journal {
  append(entry: JournalEntry): void;
  entries(): readonly JournalEntry[];
  subscribe(listener: (entry: JournalEntry) => void): () => void;
}

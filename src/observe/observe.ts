/**
 * The `observe` engine: a platform-neutral projection of a chat's visible
 * conversation and available actions, built from the runtime's structured
 * journal ({@link "../journal/journal.js".JournalEntry}) rather than from any
 * platform's own wire types.
 *
 * @remarks
 * A faithful TypeScript port of the Go runtime's `observe` package (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}
 * ports the observation model "as an algorithm", never as shared code). An
 * {@link ObserveEngine} turns a chat's journal into a sequence of
 * {@link Observation}s. Each Observation carries the chat's currently visible
 * messages, their currently available actions, and the explicit
 * {@link Change}s since the Engine's previous Observation — an actor is never
 * required to diff two Observations by hand.
 *
 * Raw platform payloads (Telegram callback data, native message ids, wire
 * envelopes, ...) never reach this module's exported types: they stay on the
 * {@link "../journal/journal.js".JournalEntry} and remain available to
 * developers only through the journal trace, never through an
 * {@link Observation} or {@link AvailableAction}.
 */

/**
 * Identifies the chat an {@link Observation} projects. It carries
 * Chatwright's own chat identity, never a raw platform chat id scraped from
 * the wire.
 */
export interface ChatRef {
  readonly chatId: number;
}

/**
 * Identifies which side of a conversation produced a {@link VisibleMessage}.
 * A string-literal union (never an integer enum) so it marshals to
 * human-readable JSON.
 */
export type Actor = "user" | "bot";

/**
 * One user-visible logical message: stable identity across edits, a
 * monotonic version and an edited flag, plus the actions currently attached
 * to it. Only normalised text and action labels are carried — no
 * platform-native message ids, callback data or wire payloads.
 */
export interface VisibleMessage {
  /** Stable synthetic Chatwright identity for this logical message, e.g. `"msg7"`. */
  readonly id: string;
  /** Monotonic version of this logical message; `0` for the original send. */
  readonly version: number;
  /** `true` once {@link VisibleMessage.version} has advanced past `0`. */
  readonly edited: boolean;
  /** Who produced the message. */
  readonly actor: Actor;
  readonly text: string;
  /** Interactions currently attached to this message. */
  readonly actions: readonly AvailableAction[];
}

/**
 * A generic, opaque interaction an actor can take: a stable Chatwright id
 * and its user-visible label. Platform-native callback data, request
 * payloads and button coordinates are never exposed here.
 */
export interface AvailableAction {
  /** Opaque, stable Chatwright action identity. */
  readonly id: string;
  /** User-visible text. */
  readonly label: string;
  /**
   * The {@link Observation.sequence} this action was (re)issued at; copy this
   * into an {@link ActionProposal}.
   */
  readonly seenAt: number;
}

/**
 * Classifies one entry in an {@link Observation}'s changes feed. A
 * string-literal union (never an integer enum) so it marshals to
 * human-readable JSON.
 */
export type ChangeKind = "new-message" | "edited-message" | "actions-changed";

/**
 * One explicit, structured difference between an {@link Observation} and the
 * Engine's previous Observation, computed by the Engine so actors reason
 * about what changed without diffing two Observations themselves.
 */
export interface Change {
  readonly kind: ChangeKind;
  readonly messageId: string;
  readonly actor: Actor;
  /** Set for `"edited-message"`: the message's version before this change; `0` otherwise. */
  readonly previousVersion: number;
  /**
   * The message's version after this change (`"new-message"`,
   * `"edited-message"`) or its current, unchanged version
   * (`"actions-changed"`).
   */
  readonly version: number;
}

/**
 * One platform-neutral snapshot of a chat's visible conversation and
 * available actions, with explicit lineage back to the Engine's previous
 * Observation. Observations are produced by an {@link ObserveEngine} — actors
 * never build or diff one by hand.
 */
export interface Observation {
  /** Monotonic per Engine, starting at `1`. */
  readonly sequence: number;
  /** The sequence of the Observation this one supersedes; `0` for an Engine's first Observation. */
  readonly previousSequence: number;
  readonly chat: ChatRef;
  /** Chronological, oldest to newest: one entry per currently visible logical message. */
  readonly messages: readonly VisibleMessage[];
  /** Empty for an Engine's first Observation; otherwise the explicit differences since {@link Observation.previousSequence}. */
  readonly changes: readonly Change[];
}

/**
 * An actor's intent to activate a previously observed action: the
 * Observation it was chosen from, and the action's stable id. Validate (see
 * {@link ObserveEngine.validate}) checks it against the Engine's CURRENT
 * journal state — the actor proposes intent, it never makes that intent
 * authoritative by asserting it.
 */
export interface ActionProposal {
  readonly observationSequence: number;
  readonly actionId: string;
}

/**
 * The deterministic outcome of validating an {@link ActionProposal}. A
 * string-literal union (never an integer enum) so it marshals to
 * human-readable JSON.
 */
export type Verdict = "fresh" | "stale";

/**
 * The deterministic result of validating an {@link ActionProposal}.
 */
export interface ValidationResult {
  readonly verdict: Verdict;
  /** Explains the verdict; always set. */
  readonly reason: string;
  /** The action's current form; set only when {@link ValidationResult.verdict} is `"fresh"`. */
  readonly current?: AvailableAction;
}

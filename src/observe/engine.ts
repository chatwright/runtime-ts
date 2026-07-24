/**
 * {@link ObserveEngine}: projects {@link Observation}s for one chat from a
 * {@link Journaler}'s structured journal, owns the per-Engine observation
 * sequence, and validates later action proposals against the current journal
 * state.
 */

import type { JournalEntry, JournalAction } from "../journal/journal.js";
import type {
  AvailableAction,
  Change,
  ChatRef,
  Observation,
  VisibleMessage,
  ActionProposal,
  ValidationResult,
} from "./observe.js";

/**
 * The read seam an {@link ObserveEngine} projects Observations from — the
 * subset of the runtime's journal access this module depends on. Tests may
 * supply a narrow fake without running an emulator.
 *
 * @remarks
 * Mirrors the Go runtime's `observe.Journaler`. The runtime-ts
 * {@link "../journal/journal.js".Journal} is already scoped to one chat; wrap
 * one with {@link journalerOf} to obtain a Journaler.
 */
export interface Journaler {
  /** Returns `chatId`'s chronological, structured journal entries. */
  journal(chatId: number): readonly JournalEntry[];
}

/**
 * Adapts any per-chat journal source (the runtime's
 * {@link "../journal/journal.js".Journal}, or a bare `entries()` provider)
 * into a {@link Journaler}. The `chatId` is ignored because a per-chat
 * journal already scopes it.
 */
export function journalerOf(source: {
  entries(): readonly JournalEntry[];
}): Journaler {
  return { journal: () => source.entries() };
}

/**
 * Projects Observations for one chat from a {@link Journaler}'s structured
 * journal. It owns the per-Engine observation sequence and remembers every
 * Observation it has issued, so changes are always computed by the Engine —
 * never by the actor — and a later action proposal can be validated against
 * the Observation it was chosen from (see {@link ObserveEngine.validate}).
 */
export class ObserveEngine {
  #seq = 0;
  #last: Observation | undefined;
  /**
   * Remembers every Observation this Engine has produced, by sequence, so
   * {@link ObserveEngine.validate} can tell an unknown/fabricated observation
   * sequence apart from a stale one.
   */
  readonly #issued = new Map<number, Observation>();

  constructor(
    private readonly journaler: Journaler,
    private readonly chat: ChatRef,
  ) {}

  /**
   * Projects the chat's current journal state into a new {@link Observation}.
   * Its changes are computed against the Engine's previously issued
   * Observation, if any — the actor is never asked to diff two Observations
   * itself.
   */
  observe(): Observation {
    const entries = this.journaler.journal(this.chat.chatId);

    this.#seq++;
    const messages = projectMessages(entries, this.#seq);
    const previous = this.#last;
    const obs: Observation = {
      sequence: this.#seq,
      previousSequence: previous ? previous.sequence : 0,
      chat: this.chat,
      messages,
      changes: previous ? diff(previous, messages) : [],
    };
    this.#last = obs;
    this.#issued.set(obs.sequence, obs);
    return obs;
  }

  /**
   * Checks `proposal` against the Engine's CURRENT journal state — never
   * against the (possibly outdated) Observation the actor originally saw —
   * and returns a deterministic fresh/stale verdict with a reason. It does
   * not execute anything, and it does not itself issue or count as a new
   * Observation.
   */
  validate(proposal: ActionProposal): ValidationResult {
    if (!this.#issued.has(proposal.observationSequence)) {
      return {
        verdict: "stale",
        reason: `observation ${proposal.observationSequence} is unknown to this engine`,
      };
    }

    const entries = this.journaler.journal(this.chat.chatId);
    const current = projectMessages(entries, this.#seq);

    for (const message of current) {
      for (const action of message.actions) {
        if (action.id === proposal.actionId) {
          return {
            verdict: "fresh",
            reason: "action is currently available",
            current: action,
          };
        }
      }
    }

    return {
      verdict: "stale",
      reason: `action "${proposal.actionId}" is no longer available (its message was edited or its actions changed)`,
    };
  }
}

/**
 * Projects entries into the current (latest-version) state of each logical
 * message, in first-seen chronological order — a message keeps its
 * conversational position across edits. `seq` stamps every
 * {@link AvailableAction} surfaced in the result.
 */
function projectMessages(
  entries: readonly JournalEntry[],
  seq: number,
): VisibleMessage[] {
  const order: number[] = []; // journal message ids in first-seen order
  const latest = new Map<number, JournalEntry>();
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    if (!latest.has(entry.messageId)) order.push(entry.messageId);
    latest.set(entry.messageId, entry);
  }

  const messages: VisibleMessage[] = [];
  for (const id of order) {
    const entry = latest.get(id)!;
    messages.push({
      id: visibleMessageId(entry.messageId),
      version: entry.version,
      edited: entry.version > 0,
      actor: entry.direction === "bot" ? "bot" : "user",
      text: entry.text,
      actions: projectActions(entry, seq),
    });
  }
  return messages;
}

/**
 * Converts an entry's raw platform action rows into the opaque, stable
 * {@link AvailableAction}s an actor sees: a label and a Chatwright-synthetic
 * id derived from the owning message's identity, version and position — never
 * the platform's own callback data or button coordinates.
 */
function projectActions(entry: JournalEntry, seq: number): AvailableAction[] {
  const actions: AvailableAction[] = [];
  const rows = entry.actions ?? [];
  rows.forEach((cols: readonly JournalAction[], row: number) => {
    cols.forEach((action: JournalAction, col: number) => {
      actions.push({
        id: availableActionId(entry.messageId, entry.version, row, col),
        label: action.label,
        seenAt: seq,
      });
    });
  });
  return actions;
}

/**
 * Derives a {@link VisibleMessage}'s stable synthetic id from the journal's
 * logical message identity.
 */
function visibleMessageId(journalMessageId: number): string {
  return `msg${journalMessageId}`;
}

/**
 * Derives an {@link AvailableAction}'s stable synthetic id from the owning
 * message's identity, version and position, in EXACTLY the form
 * `act-<msgID>-<version>-r<row>c<col>`. Encoding version means an edit that
 * changes a message's actions (or removes them) mints entirely new action
 * ids, so a proposal targeting the old ones is deterministically stale.
 */
function availableActionId(
  msgId: number,
  version: number,
  row: number,
  col: number,
): string {
  return `act-${msgId}-${version}-r${row}c${col}`;
}

/**
 * Computes the explicit changes between `prev` and the current messages —
 * new messages, edited messages (version advanced) and actions-changed
 * (version unchanged, available actions differ) — so actors never diff two
 * Observations themselves.
 */
function diff(prev: Observation, curr: readonly VisibleMessage[]): Change[] {
  const prevById = new Map<string, VisibleMessage>();
  for (const message of prev.messages) prevById.set(message.id, message);

  const changes: Change[] = [];
  for (const message of curr) {
    const prevMsg = prevById.get(message.id);
    if (prevMsg === undefined) {
      changes.push({
        kind: "new-message",
        messageId: message.id,
        actor: message.actor,
        previousVersion: 0,
        version: message.version,
      });
    } else if (message.version > prevMsg.version) {
      changes.push({
        kind: "edited-message",
        messageId: message.id,
        actor: message.actor,
        previousVersion: prevMsg.version,
        version: message.version,
      });
    } else if (!sameActionIds(prevMsg.actions, message.actions)) {
      changes.push({
        kind: "actions-changed",
        messageId: message.id,
        actor: message.actor,
        previousVersion: 0,
        version: message.version,
      });
    }
  }
  return changes;
}

/** Reports whether `a` and `b` list the same action ids in the same order. */
function sameActionIds(
  a: readonly AvailableAction[],
  b: readonly AvailableAction[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id) return false;
  }
  return true;
}

import { describe, expect, it } from "vitest";

import type { JournalEntry, JournalAction } from "../journal/journal.js";
import { ObserveEngine, type Journaler } from "./engine.js";
import { observedBotEffect, semanticallyEqualMessage } from "./effect.js";
import type { Observation, VisibleMessage } from "./observe.js";

/**
 * A {@link Journaler} over a caller-controlled, mutable entry set — used to
 * exercise Engine transitions (a send-then-edit, or available actions
 * changing without a version bump) without running a platform emulator, the
 * TS twin of the Go tests' `fakeJournaler`.
 */
class FakeJournaler implements Journaler {
  entries: JournalEntry[] = [];
  journal(): readonly JournalEntry[] {
    return [...this.entries];
  }
}

/** Builds a `"message"` journal entry with sensible defaults for the fields a test does not care about. */
function messageEntry(
  fields: {
    direction: "user" | "bot";
    messageId: number;
    text: string;
    version?: number;
    actions?: readonly (readonly JournalAction[])[];
  },
): JournalEntry {
  return {
    direction: fields.direction,
    kind: "message",
    messageId: fields.messageId,
    refMessageId: 0,
    version: fields.version ?? 0,
    text: fields.text,
    actions: fields.actions,
    method: fields.direction === "bot" ? "sendMessage" : "",
    at: "2026-07-24T12:00:00.000Z",
    fromId: fields.direction === "bot" ? 1000 : 7,
  };
}

/** One inline-keyboard button as a {@link JournalAction} row-column entry. */
function action(label: string, id: string): JournalAction {
  return { label, id, url: "" };
}

describe("ObserveEngine: message identity is stable across edits", () => {
  it("observes one logical message with a bumped version and an explicit edited change, never two", () => {
    const fj = new FakeJournaler();
    fj.entries.push(messageEntry({ direction: "bot", messageId: 7, text: "Hello" }));
    const engine = new ObserveEngine(fj, { chatId: 7 });

    const first = engine.observe();
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.version).toBe(0);
    expect(first.messages[0]!.edited).toBe(false);
    const firstId = first.messages[0]!.id;

    // The bot edits the message in place: a new versioned entry for the same
    // logical message id, exactly as the journal records an edit.
    fj.entries.push(messageEntry({ direction: "bot", messageId: 7, text: "Hello, edited", version: 1 }));

    const second = engine.observe();
    expect(second.messages).toHaveLength(1);
    const got = second.messages[0]!;
    expect(got.id).toBe(firstId); // stable logical identity
    expect(got.edited).toBe(true);
    expect(got.version).toBe(1);
    expect(got.text).toBe("Hello, edited");

    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]).toMatchObject({
      kind: "edited-message",
      messageId: firstId,
      previousVersion: 0,
      version: 1,
    });
  });
});

describe("ObserveEngine: changes are explicit", () => {
  it("hands the actor a new-message and an actions-changed diff rather than requiring it to diff two observations", () => {
    const fj = new FakeJournaler();
    fj.entries.push(
      messageEntry({ direction: "bot", messageId: 1, text: "Pick one", actions: [[action("Yes", "cb_yes")]] }),
    );
    const engine = new ObserveEngine(fj, { chatId: 1 });

    const obs1 = engine.observe();
    expect(obs1.changes).toHaveLength(0);
    expect(obs1.messages).toHaveLength(1);
    expect(obs1.messages[0]!.actions).toHaveLength(1);

    // Message 1 gains a second action without its version advancing
    // (actions-changed), and an unrelated new user message appears.
    fj.entries.push(
      messageEntry({
        direction: "bot",
        messageId: 1,
        text: "Pick one",
        actions: [[action("Yes", "cb_yes"), action("No", "cb_no")]],
      }),
      messageEntry({ direction: "user", messageId: 2, text: "hi" }),
    );

    const obs2 = engine.observe();
    expect(obs2.messages).toHaveLength(2);

    const actionsMsg = obs2.messages.find((m) => m.text === "Pick one")!;
    const newMsg = obs2.messages.find((m) => m.text === "hi")!;
    expect(actionsMsg.id).toBe(obs1.messages[0]!.id); // identity unchanged across an actions-only update
    expect(actionsMsg.version).toBe(obs1.messages[0]!.version);
    expect(actionsMsg.edited).toBe(false);
    expect(actionsMsg.actions).toHaveLength(2);

    expect(obs2.changes).toHaveLength(2);
    expect(obs2.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "new-message", messageId: newMsg.id }),
        expect.objectContaining({ kind: "actions-changed", messageId: actionsMsg.id }),
      ]),
    );
  });
});

describe("ObserveEngine: opaque synthetic action ids", () => {
  it("mints ids in exactly the act-<msgID>-<version>-r<row>c<col> form", () => {
    const fj = new FakeJournaler();
    fj.entries.push(
      messageEntry({
        direction: "bot",
        messageId: 7,
        version: 3,
        text: "grid",
        actions: [
          [action("A", "cb_a"), action("B", "cb_b")],
          [action("C", "cb_c")],
        ],
      }),
    );
    const engine = new ObserveEngine(fj, { chatId: 7 });
    const obs = engine.observe();
    const ids = obs.messages[0]!.actions.map((a) => a.id);
    expect(ids).toEqual(["act-7-3-r0c0", "act-7-3-r0c1", "act-7-3-r1c0"]);
    // Every action is stamped with the observation sequence it was issued at.
    expect(obs.messages[0]!.actions.every((a) => a.seenAt === obs.sequence)).toBe(true);
  });
});

describe("ObserveEngine.validate: fresh vs stale", () => {
  it("is fresh immediately after observing, stale once the actions change, stale for an unknown sequence", () => {
    const fj = new FakeJournaler();
    fj.entries.push(
      messageEntry({
        direction: "bot",
        messageId: 5,
        text: "Continue?",
        actions: [[action("Yes", "cb_yes"), action("No", "cb_no")]],
      }),
    );
    const engine = new ObserveEngine(fj, { chatId: 9 });

    const obs1 = engine.observe();
    expect(obs1.messages[0]!.actions).toHaveLength(2);
    const targetActionId = obs1.messages[0]!.actions[0]!.id;

    const fresh = engine.validate({ observationSequence: obs1.sequence, actionId: targetActionId });
    expect(fresh.verdict).toBe("fresh");
    expect(fresh.current?.label).toBe("Yes");

    // The bot replaces its available actions by editing the message.
    fj.entries.push(messageEntry({ direction: "bot", messageId: 5, text: "Never mind", version: 1 }));

    const stale = engine.validate({ observationSequence: obs1.sequence, actionId: targetActionId });
    expect(stale.verdict).toBe("stale");
    expect(stale.reason).not.toBe("");
    expect(stale.current).toBeUndefined();

    const unknown = engine.validate({ observationSequence: 999, actionId: targetActionId });
    expect(unknown.verdict).toBe("stale");
  });
});

describe("ObserveEngine: raw platform payloads are hidden", () => {
  it("never carries raw callback data in any observation field, however deeply nested", () => {
    const secret = "super-secret-callback-payload-42";
    const fj = new FakeJournaler();
    fj.entries.push(
      messageEntry({
        direction: "bot",
        messageId: 3,
        text: "Ready to book?",
        actions: [[action("Book now", secret)]],
      }),
    );
    const engine = new ObserveEngine(fj, { chatId: 11 });
    const obs = engine.observe();

    const observedAction = obs.messages[0]!.actions[0]!;
    expect(observedAction.label).toBe("Book now");
    expect(observedAction.id).not.toBe(secret);
    expect(JSON.stringify(obs)).not.toContain(secret);

    // The raw data is withheld from the observation, not deleted: it remains
    // available through the journal trace.
    const journalHasSecret = fj
      .journal()
      .some((e) => (e.actions ?? []).some((row) => row.some((a) => a.id === secret)));
    expect(journalHasSecret).toBe(true);
  });
});

describe("semanticallyEqualMessage / observedBotEffect", () => {
  const withActions = (text: string, labels: string[]): VisibleMessage => ({
    id: "msg1",
    version: 0,
    edited: false,
    actor: "bot",
    text,
    actions: labels.map((label, i) => ({ id: `act-1-0-r0c${i}`, label, seenAt: 1 })),
  });

  it("compares actions by label, not id, so an idempotent re-render is equal", () => {
    const a = withActions("Same screen", ["Yes", "No"]);
    // Same content, but the version bumped so ids differ (they encode version).
    const b: VisibleMessage = {
      ...a,
      version: 1,
      edited: true,
      actions: a.actions.map((x, i) => ({ ...x, id: `act-1-1-r0c${i}` })),
    };
    expect(semanticallyEqualMessage(a, b)).toBe(true);
  });

  it("reports a real text change and a real label change as not equal", () => {
    const base = withActions("Pick one", ["Yes", "No"]);
    expect(semanticallyEqualMessage(base, withActions("Pick two", ["Yes", "No"]))).toBe(false);
    expect(semanticallyEqualMessage(base, withActions("Pick one", ["Yes", "Nope"]))).toBe(false);
  });

  it("observedBotEffect ignores a content-identical bot re-render but flags a genuine change", () => {
    const pre: Observation = {
      sequence: 1,
      previousSequence: 0,
      chat: { chatId: 1 },
      messages: [withActions("Same screen", ["Yes", "No"])],
      changes: [],
    };

    // A version-only re-render: same content, so observe still reports an
    // edited-message change, but it is not progress.
    const rerender: Observation = {
      sequence: 2,
      previousSequence: 1,
      chat: { chatId: 1 },
      messages: [{ ...withActions("Same screen", ["Yes", "No"]), version: 1, edited: true }],
      changes: [{ kind: "edited-message", messageId: "msg1", actor: "bot", previousVersion: 0, version: 1 }],
    };
    expect(observedBotEffect(pre, rerender)).toBe(false);

    // A genuine content change is progress.
    const changed: Observation = {
      ...rerender,
      messages: [{ ...withActions("A different screen", ["Yes", "No"]), version: 1, edited: true }],
    };
    expect(observedBotEffect(pre, changed)).toBe(true);

    // A change authored by the user (the actor's own echo) is never an effect.
    const userEcho: Observation = {
      sequence: 2,
      previousSequence: 1,
      chat: { chatId: 1 },
      messages: [withActions("Same screen", ["Yes", "No"]), { ...withActions("hi", []), id: "msg2", actor: "user" }],
      changes: [{ kind: "new-message", messageId: "msg2", actor: "user", previousVersion: 0, version: 0 }],
    };
    expect(observedBotEffect(pre, userEcho)).toBe(false);
  });
});

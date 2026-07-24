import { describe, expect, it } from "vitest";

import type { JournalEntry, JournalAction } from "../journal/journal.js";
import { evaluateAssertions, type Assertion, type DataStateAssertion } from "./assertions.js";

function botMessage(fields: {
  messageId: number;
  text: string;
  version?: number;
  actions?: readonly (readonly JournalAction[])[];
  at?: string;
}): JournalEntry {
  return {
    direction: "bot",
    kind: "message",
    messageId: fields.messageId,
    refMessageId: 0,
    version: fields.version ?? 0,
    text: fields.text,
    actions: fields.actions,
    method: "sendMessage",
    at: fields.at ?? "2026-07-24T12:00:00.000Z",
    fromId: 1,
  };
}

function userMessage(text: string, messageId: number, at = "2026-07-24T12:00:00.000Z"): JournalEntry {
  return { direction: "user", kind: "message", messageId, refMessageId: 0, version: 0, text, method: "", at, fromId: 7 };
}

const action = (label: string, id: string): JournalAction => ({ label, id, url: "" });

describe("evaluateAssertions: text and action assertions", () => {
  const entries: JournalEntry[] = [
    userMessage("/start", 1),
    botMessage({ messageId: 2, text: "Choose your language", actions: [[action("English", "lang:en")]] }),
    botMessage({ messageId: 2, text: "Howdy stranger", version: 1, actions: [[action("English", "lang:en")]] }),
    botMessage({ messageId: 3, text: "Anything else?" }),
  ];

  it("evaluates text-equals / text-contains / text-matches against the latest version of a targeted turn", () => {
    const assertions: Assertion[] = [
      { kind: "text-equals", botTurn: 1, text: "Howdy stranger" },
      { kind: "text-contains", botTurn: 1, substring: "Howdy" },
      { kind: "text-matches", botTurn: 2, pattern: "^Anything.*\\?$" },
      { kind: "text-equals", botTurn: 1, text: "Choose your language" }, // stale (pre-edit) text — must fail
    ];
    const outcomes = evaluateAssertions(entries, assertions);
    expect(outcomes.map((o) => o.verdict)).toEqual(["pass", "pass", "pass", "fail"]);
    expect(outcomes[3]!.diagnostic).toContain("Howdy stranger");
  });

  it("evaluates expects-action and edited", () => {
    const outcomes = evaluateAssertions(entries, [
      { kind: "expects-action", botTurn: 1, label: "English" },
      { kind: "expects-action", botTurn: 1, actionId: "lang:en" },
      { kind: "expects-action", botTurn: 1, label: "Nope" },
      { kind: "edited", botTurn: 1 },
      { kind: "edited", botTurn: 2 },
    ]);
    expect(outcomes.map((o) => o.verdict)).toEqual(["pass", "pass", "fail", "pass", "fail"]);
  });

  it("defaults to the latest bot message when no turn is given, and fails a turn that never happened", () => {
    const outcomes = evaluateAssertions(entries, [
      { kind: "text-equals", text: "Anything else?" }, // latest bot message
      { kind: "text-equals", botTurn: 9, text: "x" }, // out of range
    ]);
    expect(outcomes[0]!.verdict).toBe("pass");
    expect(outcomes[1]!.verdict).toBe("fail");
    expect(outcomes[1]!.diagnostic).toContain("only 2 bot message");
  });

  it("bounds latency with within, using the preceding user entry's timestamp", () => {
    const timed: JournalEntry[] = [
      userMessage("hi", 1, "2026-07-24T12:00:00.000Z"),
      botMessage({ messageId: 2, text: "reply", at: "2026-07-24T12:00:00.200Z" }),
    ];
    const outcomes = evaluateAssertions(timed, [
      { kind: "within", botTurn: 1, ms: 500 },
      { kind: "within", botTurn: 1, ms: 100 },
    ]);
    expect(outcomes[0]!.verdict).toBe("pass");
    expect(outcomes[1]!.verdict).toBe("fail");
    expect(outcomes[1]!.diagnostic).toContain("200ms");
  });
});

describe("evaluateAssertions: side-effect assertions", () => {
  const entries = [botMessage({ messageId: 1, text: "done" })];
  const dataState: DataStateAssertion = { kind: "data-state", name: "item-count", query: "SELECT count(*) FROM items" };

  it("reports data-state as unverified with a browser-limitation reason when no verifier is supplied", () => {
    const [outcome] = evaluateAssertions(entries, [dataState]);
    expect(outcome!.verdict).toBe("unverified");
    expect(outcome!.diagnostic).toContain("companion verification server");
  });

  it("defers to a pluggable verifier when one is supplied", () => {
    const [outcome] = evaluateAssertions(entries, [dataState], {
      verifier: (a) => ({ kind: "data-state", verdict: "pass", diagnostic: `verified ${a.name}` }),
    });
    expect(outcome!.verdict).toBe("pass");
    expect(outcome!.diagnostic).toBe("verified item-count");
  });
});

/**
 * Cross-runtime byte-parity tests for the independent journal `verify`
 * evaluator — ported case-for-case from `runtime-go`'s
 * `scenario/verify_test.go`. The literal strings asserted here
 * (`UNMET_PREFIX`, the `"; "` join, and every `unmetDetail`/`metDetail`
 * fixture string) are copied verbatim from the Go test file: this file
 * is the parity evidence that `runtime-ts`'s evaluator produces a
 * byte-identical detail string to `runtime-go`'s `scenario.VerifySpec.Evaluate`
 * for the same inputs, per the format README's "the whole detail string is
 * byte-comparable across runtimes" rule.
 */

import { describe, expect, it } from "vitest";
import type { JournalEntry, JournalDirection } from "../journal/journal.js";
import { compileVerifyBlock, UNMET_PREFIX } from "./document-verify.js";
import type { Verify } from "./document.js";

function msg(direction: JournalDirection, text: string, version: number): JournalEntry {
  return { direction, kind: "message", messageId: 1, refMessageId: 0, version, text, method: "", at: "", fromId: 0 };
}

describe("UNMET_PREFIX is pinned byte-for-byte to runtime-go's scenario.UnmetPrefix", () => {
  it("is exactly \"journal evidence incomplete: \"", () => {
    // Copied verbatim from runtime-go/scenario/verify.go's UnmetPrefix constant.
    expect(UNMET_PREFIX).toBe("journal evidence incomplete: ");
  });
});

describe("VerifySpec.evaluate: ordered expectations all met", () => {
  it("verifies and reports the spec's own metDetail", () => {
    const verify: Verify = {
      chat: "main",
      metDetail: "all good",
      journal: [
        { id: "a", unmetDetail: "no a", all: [
          { field: "direction", op: "exact", value: "user" },
          { field: "text", op: "exact", value: "/start" },
        ] },
        { id: "b", unmetDetail: "no b", all: [
          { field: "direction", op: "exact", value: "bot" },
          { field: "edited", op: "exact", value: true },
        ] },
      ],
    };
    const spec = compileVerifyBlock(verify);

    const entries: JournalEntry[] = [
      msg("user", "/start", 0),
      msg("bot", "picker", 0),
      msg("bot", "Howdy stranger", 1), // edited
    ];
    const got = spec.evaluate(entries);
    expect(got.verified).toBe(true);
    expect(got.detail).toBe("all good");
  });
});

describe("VerifySpec.evaluate: unmet expectations join in declared order with the pinned prefix", () => {
  it("matches runtime-go's byte-identical detail string", () => {
    const verify: Verify = {
      chat: "main",
      metDetail: "met",
      journal: [
        { id: "a", unmetDetail: "never sent /start", all: [{ field: "text", op: "exact", value: "/start" }] },
        { id: "b", unmetDetail: "never greeted", all: [{ field: "text", op: "exact", value: "Howdy stranger" }] },
      ],
    };
    const spec = compileVerifyBlock(verify);

    const got = spec.evaluate([]); // empty journal: both expectations unmet
    expect(got.verified).toBe(false);
    // Copied verbatim from runtime-go's
    // TestVerifySpec_UnmetExpectationsJoinInDeclaredOrderWithPinnedPrefix.
    const want = UNMET_PREFIX + "never sent /start; never greeted";
    expect(got.detail).toBe(want);
    expect(got.detail).toBe("journal evidence incomplete: never sent /start; never greeted");
  });
});

describe("VerifySpec.evaluate: ordering is strict", () => {
  it("does not let expectation N match an entry before the entry expectation N-1 matched", () => {
    const verify: Verify = {
      chat: "main",
      metDetail: "met",
      journal: [
        { id: "first", unmetDetail: "no first", all: [{ field: "text", op: "exact", value: "A" }] },
        { id: "second", unmetDetail: "no second", all: [{ field: "text", op: "exact", value: "B" }] },
      ],
    };
    const spec = compileVerifyBlock(verify);

    // "B" appears before "A" in the journal — must not verify.
    const outOfOrder: JournalEntry[] = [msg("user", "B", 0), msg("user", "A", 0)];
    expect(spec.evaluate(outOfOrder).verified).toBe(false);

    // The correctly ordered journal does verify.
    const inOrder: JournalEntry[] = [msg("user", "A", 0), msg("user", "B", 0)];
    const got = spec.evaluate(inOrder);
    expect(got.verified).toBe(true);
  });
});

describe("VerifySpec.evaluate: negate and regex", () => {
  it("excludes a negated exact match and matches a non-empty regex", () => {
    const verify: Verify = {
      chat: "main",
      metDetail: "met",
      journal: [
        {
          id: "ack",
          unmetDetail: "no ack",
          all: [
            { field: "text", op: "regex", value: "\\S" },
            { field: "text", op: "exact", value: "/start", negate: true },
          ],
        },
      ],
    };
    const spec = compileVerifyBlock(verify);

    expect(spec.evaluate([msg("user", "/start", 0)]).verified).toBe(false);
    expect(spec.evaluate([msg("user", "Thanks!", 0)]).verified).toBe(true);
  });
});

describe("compileVerify: undefined for a document with no verify block", () => {
  it("returns undefined, never throws", async () => {
    const { compileVerify } = await import("./document-verify.js");
    const spec = compileVerify({
      format: "https://chatwright.dev/formats/scenario-document/v1",
      schemaVersion: 1,
      id: "t",
      version: "v1",
      title: "t",
      fidelity: { endpointProfile: "platform-emulated" },
      platform: "telegram",
      chats: [],
      bot: { id: "b", name: "B" },
      cast: [],
      parts: [],
    });
    expect(spec).toBeUndefined();
  });
});

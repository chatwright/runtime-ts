/**
 * The feature's named proof (AGENTS.md principle 6, "each feature proves its
 * existence"; the self-contained-scenario-documents format's
 * `greetbot-scenario-is-expressible` and `same-document-same-verdict-in-both-runtimes`
 * acceptance criteria): `testdata/greetbot-language-onboarding.json` — a
 * byte-identical copy of `runtime-go`'s own
 * `scenario/testdata/greetbot-language-onboarding.json` fixture (diffed at
 * copy time; not re-diffed here since `runtime-go` is not a build
 * dependency of this repository) — parses, validates, builds and executes to
 * the same identity, goal, budgets, roster and verify verdict `runtime-go`'s
 * `TestGreetbotDocumentReproducesArenaScenario` proves for the same file.
 *
 * This test reads only the JSON fixture — never `runtime-go`'s
 * `arena.GreetbotScenario()` (this repository cannot import Go code at all)
 * and never this repository's own `greetbot.ts` constants for the
 * DOCUMENT-side assertions — mirroring the Go conformance test's own
 * discipline of building the document side of every comparison purely from
 * the parsed file. Where it DOES compare against `greetbot.ts` (this
 * runtime's own hand-authored greetbot scenario), that comparison is itself
 * part of the proof: both must describe the same goal.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseScenarioDocument } from "./document-parse.js";
import { buildScenarioRun, ScenarioBuildError } from "./document-build.js";
import { compileVerify, UNMET_PREFIX } from "./document-verify.js";
import { resolveFidelity } from "./document-fidelity.js";
import { greetbotGoal, GREETBOT_TASK_ID } from "./greetbot.js";
import { executeRun } from "../run/run.js";
import type { Document } from "./document.js";

const fixturePath = fileURLToPath(new URL("./testdata/greetbot-language-onboarding.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");

describe("greetbot-scenario-is-expressible: the shared document fixture parses and validates", () => {
  it("accepts the fixture with no error-severity issues", () => {
    const { document, report, error } = parseScenarioDocument(fixtureText);
    expect(error).toBeUndefined();
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(document).toBeDefined();
  });

  it("resolves the same scenario id, version, title and requires as the raw JSON declares", () => {
    const { document } = parseScenarioDocument(fixtureText);
    const doc = document!;
    // Copied verbatim from the fixture (and from runtime-go's identical
    // testdata/greetbot-language-onboarding.json).
    expect(doc.id).toBe("greetbot-language-onboarding");
    expect(doc.version).toBe("v1");
    expect(doc.title).toBe("Complete language onboarding and acknowledge the greeting");
    expect(doc.requires).toEqual(["ai-goal", "exampleBot:greetbot"]);
    expect(doc.fidelity).toEqual({ endpointProfile: "platform-emulated", environment: "dev", dataSensitivity: "synthetic" });
    expect(doc.platform).toBe("telegram");
  });

  it("resolves the same chat, bot endpoint and cast roster identity as the raw JSON declares", () => {
    const { document } = parseScenarioDocument(fixtureText);
    const doc = document!;
    expect(doc.chats).toEqual([{ id: "main", platformChatId: 42 }]);
    expect(doc.bot).toEqual({ id: "greetbot", name: "GreetBot", exampleBot: "greetbot" });
    expect(doc.cast).toHaveLength(1);
    expect(doc.cast[0]!.platformIdentity).toEqual({ userId: 7, firstName: "Arena" });
    expect(doc.cast[0]!.provider).toEqual({ kind: "cassette", mode: "replay", cassette: "cassettes/greetbot-language-onboarding.json" });
  });

  it("resolves the same goal id, task id, budgets and byte-identical successCriteria as this runtime's own greetbot.ts", () => {
    const { document } = parseScenarioDocument(fixtureText);
    const doc = document!;
    expect(doc.parts).toHaveLength(1);
    const docGoal = doc.parts[0]!.goal!;
    const reference = greetbotGoal(); // this runtime's own hand-authored greetbot goal.

    expect(docGoal.id).toBe(reference.id);
    expect(docGoal.title).toBe(reference.title);
    expect(docGoal.tasks).toHaveLength(1);
    expect(reference.tasks).toHaveLength(1);
    expect(docGoal.tasks[0]!.id).toBe(GREETBOT_TASK_ID);
    expect(docGoal.tasks[0]!.id).toBe(reference.tasks[0]!.id);
    // Byte-identical prose — the format README's "successCriteria is the Go
    // string verbatim" rule, now also true of this runtime's own scenario.
    expect(docGoal.tasks[0]!.successCriteria).toBe(reference.tasks[0]!.successCriteria);

    expect(docGoal.budgets.maxSteps).toBe(12);
    expect(docGoal.budgets.maxSteps).toBe(reference.budgets!.maxSteps);
    expect((docGoal.budgets.maxDurationSeconds ?? 0) * 1000).toBe(reference.budgets!.maxDurationMs);
  });

  it("reports no-run-ceiling as a warning (the document declares no ceiling) and no error-severity issues", () => {
    const { report } = parseScenarioDocument(fixtureText);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("no-run-ceiling");
    expect(report.issues.some((i) => i.code === "no-independent-verification")).toBe(false); // this fixture DOES declare verify.
  });
});

describe("same-document-same-verdict-in-both-runtimes: build, execute and verify against the shared fixture", () => {
  it("builds a run whose resolved chat/user/goal match the document, with the cassette override recorded honestly", () => {
    const { document } = parseScenarioDocument(fixtureText);
    const built = buildScenarioRun(document!, { now: () => 1_000 });

    expect(built.run.id).toBe("greetbot-language-onboarding");
    expect(built.run.parts).toHaveLength(1);
    const part = built.run.parts[0]!;
    expect(part.kind).toBe("ai-goal");
    if (part.kind !== "ai-goal") throw new Error("unreachable");
    expect(part.chatId).toBe(42);
    expect(part.user).toEqual({ id: 7, firstName: "Arena" });
    expect(part.actorId).toBe("arena");

    // The declared cassette provider is not run by runtime-ts (no cassette
    // engine — see document-build.ts's module doc comment); the override is
    // RECORDED, never silently presented as "the cassette ran".
    expect(built.providerOverrides).toHaveLength(1);
    expect(built.providerOverrides[0]!.castId).toBe("arena");
    expect(built.providerOverrides[0]!.declaredKind).toContain("cassette");

    expect(built.fidelity).toEqual({ endpointProfile: "platform-emulated", environment: "dev", dataSensitivity: "synthetic" });
    expect(resolveFidelity(document!)).toEqual(built.fidelity);
  });

  it("executes to completion and the independent journal verify returns the document's own metDetail — byte-identical to runtime-go's verdict for this fixture", async () => {
    const { document } = parseScenarioDocument(fixtureText);
    const built = buildScenarioRun(document!, { now: () => 1_000 });

    const result = await executeRun(built.run);
    expect(result.parts).toHaveLength(1);
    const outcome = result.parts[0]!;
    expect(outcome.kind).toBe("ai-goal");
    expect(outcome.status).toBe("completed");
    expect(outcome.aiGoal!.report.stopReason).toBe("goal-complete");

    // The evidence-over-claims re-check: same verdict AND same detail string
    // as runtime-go's TestGreetbotDocumentReproducesArenaScenario produces
    // for this identical fixture (copied verbatim from the document's own
    // "verify.metDetail" — and from runtime-go's testdata file).
    expect(outcome.aiGoal!.verify).toEqual({
      verified: true,
      detail: "started, clicked English, acknowledged — all journal-verified",
    });
  });

  it("the standalone-compiled VerifySpec agrees with the wired-in part verify, and the unmet-path detail string is byte-identical to the fixture's own unmetDetail values", async () => {
    const { document } = parseScenarioDocument(fixtureText);
    const doc = document!;
    const built = buildScenarioRun(doc, { now: () => 1_000 });
    await executeRun(built.run);

    const entries = built.session.journal(42).entries();
    const spec = compileVerify(doc)!;
    expect(spec.chatDocId).toBe("main");
    const verified = spec.evaluate(entries);
    expect(verified).toEqual({ verified: true, detail: "started, clicked English, acknowledged — all journal-verified" });

    // Truncating the journal before the greeting changed reproduces the
    // unmet path with the fixture's own unmetDetail strings (copied
    // verbatim from testdata/greetbot-language-onboarding.json and from
    // runtime-go's identical copy), joined with the pinned "; " separator.
    const onlyStart = entries.filter((e) => e.direction === "user" && e.text === "/start");
    const unmet = spec.evaluate(onlyStart);
    expect(unmet.verified).toBe(false);
    expect(unmet.detail).toBe(
      UNMET_PREFIX + "never got the English greeting (wrong/no click); never sent an acknowledgement after the greeting changed",
    );
  });
});

describe("unsupported-transport-is-refused-by-name: Build refuses what it does not wire, even when validation accepted it", () => {
  // document-validate.ts accepts transport:"iframe" (runtime-ts's supported
  // transport), but document-build.ts does not yet wire a live IframeHost
  // from a parsed document (out of this task's scope — see its module doc
  // comment). Build must refuse by name, never silently produce a Run that
  // cannot actually reach the bot.
  const iframeDoc: Document = {
    format: "https://chatwright.dev/formats/scenario-document/v1",
    schemaVersion: 1,
    id: "iframe-doc",
    version: "v1",
    title: "t",
    fidelity: { endpointProfile: "platform-emulated", environment: "dev", dataSensitivity: "synthetic" },
    platform: "telegram",
    chats: [{ id: "main", platformChatId: 1 }],
    bot: { id: "b", name: "B", transport: "iframe", url: "https://bot.example.com/embed" },
    cast: [{ id: "arena", type: "ai-agent", name: "Arena", platformIdentity: { userId: 7 }, provider: { kind: "cassette", mode: "replay", cassette: "c.json" } }],
    parts: [
      {
        id: "p1",
        kind: "ai-goal",
        chat: "main",
        actorId: "arena",
        goal: { id: "g1", title: "g", tasks: [{ id: "t1", successCriteria: "sc" }], budgets: { maxSteps: 1 } },
      },
    ],
  };

  it("throws ScenarioBuildError naming the endpoint, never approximating", () => {
    expect(() => buildScenarioRun(iframeDoc)).toThrow(ScenarioBuildError);
    try {
      buildScenarioRun(iframeDoc);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(ScenarioBuildError);
      expect((err as Error).message).toContain("exampleBot");
    }
  });

  it("also refuses a model-kind provider by name (no live-model wiring in this Build)", () => {
    const modelDoc: Document = {
      ...iframeDoc,
      bot: { id: "greetbot", name: "GreetBot", exampleBot: "greetbot" },
      requires: ["ai-goal", "exampleBot:greetbot"],
      cast: [
        {
          id: "arena",
          type: "ai-agent",
          name: "Arena",
          platformIdentity: { userId: 7 },
          provider: { kind: "model", providerId: "openai", model: "gpt-x" },
        },
      ],
    };
    expect(() => buildScenarioRun(modelDoc)).toThrow(ScenarioBuildError);
    try {
      buildScenarioRun(modelDoc);
      throw new Error("unreachable");
    } catch (err) {
      expect((err as Error).message).toContain("model");
    }
  });
});

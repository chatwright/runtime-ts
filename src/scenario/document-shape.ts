/**
 * The two whole-document generic-tree shape scans that run before any typed
 * decode — ported from `runtime-go`'s `scenario/parse.go`:
 *
 * 1. {@link scanForbiddenMembers} — the closed set of executable-string
 *    member names (`command`/`script`/`shell`/`entrypoint`), checked at
 *    every depth, anywhere in the document (the format README's "the
 *    document contains no executable strings" rule).
 * 2. {@link checkUnknownMembers} — every member name not part of the
 *    scenario-document/v1 shape is rejected, not silently ignored (the
 *    format README's "no member is silently ignored" rule). Go gets this for
 *    free from `encoding/json`'s `DisallowUnknownFields`; TypeScript has no
 *    stdlib equivalent, so this is a hand-written, shape-aware walk that
 *    mirrors the `Document` type's own member set at every nesting level.
 *
 * A handful of subtrees are deliberately walked as *opaque* by
 * {@link checkUnknownMembers} — a secret-bearing field's own value (`{"secretRef": ...}`,
 * checked instead by `document-secrets.ts`), `secrets[*].from` (checked by
 * `scanSecretsArray`), `inputs[*].default`/`cases[*].inputs[*]` (arbitrary
 * caller values), `parts[*].steps` (reserved, arbitrary shape) and
 * `verify.journal[*].all[*].value` (checked by `document-validate.ts`
 * against `field`/`op`). {@link scanForbiddenMembers} still walks every one
 * of those subtrees unconditionally — "checked at every depth" has no
 * exceptions.
 */

import { escapePointerToken, isJsonObject, sortedKeys, type JsonObject } from "./document-json.js";
import type { ReportBuilder } from "./issues.js";

/** The closed set of member names that make a document carry an executable string. */
const FORBIDDEN_MEMBERS = new Set(["command", "script", "shell", "entrypoint"]);

/** Walks `value` recursively, reporting a `SeverityError` issue for every object member whose key is in {@link FORBIDDEN_MEMBERS}, at any depth. */
export function scanForbiddenMembers(value: unknown, pointer: string, report: ReportBuilder): void {
  if (isJsonObject(value)) {
    for (const key of sortedKeys(value)) {
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      if (FORBIDDEN_MEMBERS.has(key)) {
        report.error(
          "executable-string-member",
          childPointer,
          `member "${key}" is never permitted in a scenario document — the parser accepts no executable strings`,
        );
      }
      scanForbiddenMembers(value[key], childPointer, report);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, i) => scanForbiddenMembers(child, `${pointer}/${i}`, report));
  }
}

function reportUnknown(pointer: string, key: string, report: ReportBuilder): void {
  report.error("unknown-member", `${pointer}/${escapePointerToken(key)}`, `unrecognised member "${key}" is not part of the scenario-document/v1 shape`);
}

/** Reports every key of `obj` not present in `allowed`, at `pointer`. */
function checkKeys(obj: JsonObject, allowed: readonly string[], pointer: string, report: ReportBuilder): void {
  const allow = new Set(allowed);
  for (const key of sortedKeys(obj)) {
    if (!allow.has(key)) reportUnknown(pointer, key, report);
  }
}

const ROOT_MEMBERS = [
  "format",
  "schemaVersion",
  "id",
  "version",
  "title",
  "description",
  "requires",
  "fidelity",
  "platform",
  "chats",
  "bot",
  "cast",
  "secrets",
  "inputs",
  "cases",
  "parts",
  "ceiling",
  "verify",
  "verifies",
] as const;

const FIDELITY_MEMBERS = ["endpointProfile", "environment", "dataSensitivity", "redactionPolicy"] as const;
const CHAT_MEMBERS = ["id", "platformChatId"] as const;
const BOT_MEMBERS = ["id", "name", "transport", "delivery", "url", "headers", "exampleBot"] as const;
const PLATFORM_IDENTITY_MEMBERS = ["userId", "firstName"] as const;
const CAST_MEMBERS = ["id", "type", "name", "platformIdentity", "provider"] as const;
const PROVIDER_MEMBERS = ["kind", "providerId", "model", "baseUrl", "apiKey", "mode", "cassette", "wraps"] as const;
const SECRET_MEMBERS = ["name", "from"] as const;
const INPUT_DECL_MEMBERS = ["name", "description", "default"] as const;
const CASE_DECL_MEMBERS = ["name", "inputs"] as const;
const PART_MEMBERS = ["id", "kind", "title", "chat", "actorId", "failurePolicy", "goal", "loop", "steps"] as const;
const GOAL_MEMBERS = ["id", "title", "description", "tasks", "constraints", "budgets"] as const;
const TASK_MEMBERS = ["id", "title", "dependsOn", "successCriteria", "milestones"] as const;
const BUDGETS_MEMBERS = ["maxSteps", "maxDurationSeconds", "maxCost"] as const;
const LOOP_MEMBERS = ["historyWindow", "nonProgressLimit", "actWaitTimeoutSeconds", "retainObservations", "overshootProbe"] as const;
const CEILING_MEMBERS = ["maxSteps", "maxCost", "maxDurationSeconds"] as const;
const VERIFY_MEMBERS = ["chat", "metDetail", "journal"] as const;
const JOURNAL_EXPECTATION_MEMBERS = ["id", "unmetDetail", "all"] as const;
const CONDITION_MEMBERS = ["field", "op", "value", "negate"] as const;

/**
 * Rejects every member name in `root` not part of the scenario-document/v1
 * shape, at any nesting level the shape defines — the hand-written TS
 * counterpart of Go's `DisallowUnknownFields`. Unlike Go (which stops
 * decoding at the FIRST unknown field it meets), this reports every one
 * found; both behaviours reject the same documents, which is what the
 * format's ACs require.
 */
export function checkUnknownMembers(root: JsonObject, report: ReportBuilder): void {
  checkKeys(root, ROOT_MEMBERS, "", report);

  const fidelity = asObj(root["fidelity"]);
  if (fidelity) checkKeys(fidelity, FIDELITY_MEMBERS, "/fidelity", report);

  const chats = root["chats"];
  if (Array.isArray(chats)) {
    chats.forEach((c, i) => {
      const obj = asObj(c);
      if (obj) checkKeys(obj, CHAT_MEMBERS, `/chats/${i}`, report);
    });
  }

  const bot = asObj(root["bot"]);
  if (bot) {
    checkKeys(bot, BOT_MEMBERS, "/bot", report);
    // bot.headers[*] values are secret-bearing (opaque) — checked by scanSecretBearingFields.
  }

  const cast = root["cast"];
  if (Array.isArray(cast)) {
    cast.forEach((c, i) => {
      const obj = asObj(c);
      if (!obj) return;
      const pointer = `/cast/${i}`;
      checkKeys(obj, CAST_MEMBERS, pointer, report);
      const identity = asObj(obj["platformIdentity"]);
      if (identity) checkKeys(identity, PLATFORM_IDENTITY_MEMBERS, `${pointer}/platformIdentity`, report);
      const provider = asObj(obj["provider"]);
      if (provider) checkProviderMembers(provider, `${pointer}/provider`, report);
    });
  }

  const secrets = root["secrets"];
  if (Array.isArray(secrets)) {
    secrets.forEach((s, i) => {
      const obj = asObj(s);
      if (obj) checkKeys(obj, SECRET_MEMBERS, `/secrets/${i}`, report);
      // secrets[*].from is checked by scanSecretsArray (opaque here).
    });
  }

  const inputs = root["inputs"];
  if (Array.isArray(inputs)) {
    inputs.forEach((v, i) => {
      const obj = asObj(v);
      if (obj) checkKeys(obj, INPUT_DECL_MEMBERS, `/inputs/${i}`, report);
      // .default is an arbitrary caller value (opaque).
    });
  }

  const cases = root["cases"];
  if (Array.isArray(cases)) {
    cases.forEach((v, i) => {
      const obj = asObj(v);
      if (obj) checkKeys(obj, CASE_DECL_MEMBERS, `/cases/${i}`, report);
      // .inputs[*] values are arbitrary caller values (opaque).
    });
  }

  const parts = root["parts"];
  if (Array.isArray(parts)) {
    parts.forEach((v, i) => {
      const obj = asObj(v);
      if (!obj) return;
      const pointer = `/parts/${i}`;
      checkKeys(obj, PART_MEMBERS, pointer, report);
      // .steps is reserved, arbitrary shape (opaque here).
      const goal = asObj(obj["goal"]);
      if (goal) {
        checkKeys(goal, GOAL_MEMBERS, `${pointer}/goal`, report);
        const tasks = goal["tasks"];
        if (Array.isArray(tasks)) {
          tasks.forEach((t, j) => {
            const taskObj = asObj(t);
            if (taskObj) checkKeys(taskObj, TASK_MEMBERS, `${pointer}/goal/tasks/${j}`, report);
          });
        }
        const budgets = asObj(goal["budgets"]);
        if (budgets) checkKeys(budgets, BUDGETS_MEMBERS, `${pointer}/goal/budgets`, report);
      }
      const loop = asObj(obj["loop"]);
      if (loop) checkKeys(loop, LOOP_MEMBERS, `${pointer}/loop`, report);
    });
  }

  const ceiling = asObj(root["ceiling"]);
  if (ceiling) checkKeys(ceiling, CEILING_MEMBERS, "/ceiling", report);

  const verify = asObj(root["verify"]);
  if (verify) {
    checkKeys(verify, VERIFY_MEMBERS, "/verify", report);
    const journal = verify["journal"];
    if (Array.isArray(journal)) {
      journal.forEach((exp, i) => {
        const expObj = asObj(exp);
        if (!expObj) return;
        const pointer = `/verify/journal/${i}`;
        checkKeys(expObj, JOURNAL_EXPECTATION_MEMBERS, pointer, report);
        const all = expObj["all"];
        if (Array.isArray(all)) {
          all.forEach((cond, j) => {
            const condObj = asObj(cond);
            if (condObj) checkKeys(condObj, CONDITION_MEMBERS, `${pointer}/all/${j}`, report);
            // .value's shape is field/op-dependent — checked by document-validate.ts.
          });
        }
      });
    }
  }
}

function checkProviderMembers(provider: JsonObject, pointer: string, report: ReportBuilder): void {
  checkKeys(provider, PROVIDER_MEMBERS, pointer, report);
  // .apiKey is secret-bearing (opaque) — checked by scanSecretBearingFields.
  const wraps = asObj(provider["wraps"]);
  if (wraps) checkProviderMembers(wraps, `${pointer}/wraps`, report);
}

function asObj(v: unknown): JsonObject | undefined {
  return isJsonObject(v) ? v : undefined;
}

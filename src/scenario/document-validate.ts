/**
 * Structural rule validation over an already shape-decoded {@link Document}
 * — ported from `runtime-go`'s `scenario/validate.go`, with one deliberate,
 * declared divergence: **bot transport support is the mirror image of
 * Go's**. `runtime-go` refuses `transport: "iframe"` by name (no iframe
 * host); `runtime-ts` refuses `transport: "http"` by name (a browser page
 * has no inbound HTTP server surface — see `docs/runtime-parity.md`) and
 * accepts `"iframe"`. Every other rule is a faithful, behaviour-for-behaviour
 * port: same codes, same pointers, same accept/reject outcomes.
 */

import { GoalError } from "../goal/errors.js";
import { validateGoal, type Goal as RuntimeGoal, type Task as RuntimeTask } from "../goal/goal.js";
import type {
  Bot,
  Cast,
  Condition,
  DataSensitivity,
  Document,
  DocumentBudgets,
  DocumentFailurePolicy,
  DocumentGoal,
  DocumentPart,
} from "./document.js";
import { validateFidelity } from "./document-fidelity.js";
import type { ReportBuilder } from "./issues.js";

/**
 * The `exampleBot` ids this runtime (`runtime-ts`) ships and
 * {@link validateRequires} accepts a `requires: ["exampleBot:<id>"]`
 * declaration for. Mirrors `runtime-go`'s `DefaultSupportedExampleBots` —
 * same id, greetbot, a language-neutral fixture whose *implementation*
 * differs per runtime (see `examplebots.ts`).
 */
export const DEFAULT_SUPPORTED_EXAMPLE_BOTS = new Set(["greetbot"]);

/** Everything downstream mapping (verify chat resolution, Build) needs from validation, alongside the accumulated {@link ReportBuilder}. */
export interface ValidationContext {
  readonly chatIds: ReadonlySet<string>;
  readonly castById: ReadonlyMap<string, string>;
}

/**
 * Runs every structural rule the format README describes over `doc`,
 * appending an issue to `report` for each violation. Performs no I/O: every
 * check is over `doc`'s already-decoded fields.
 */
export function validateDocument(doc: Document, report: ReportBuilder): ValidationContext {
  validateFormatAndVersion(doc, report);
  validateRequires(doc, report);
  validateFidelity(doc, report);
  validatePlatform(doc, report);
  const chatIds = validateChats(doc, report);
  validateBot(doc, report);
  const castById = validateCast(doc, report);
  validateParts(doc, report, chatIds, castById);
  validateCeiling(doc, report);
  validateVerify(doc, report, chatIds);
  return { chatIds, castById };
}

function validateFormatAndVersion(doc: Document, report: ReportBuilder): void {
  if (doc.format !== "https://chatwright.dev/formats/scenario-document/v1") {
    report.error("unsupported-format", "/format", `unsupported format "${doc.format}"; this runtime supports "https://chatwright.dev/formats/scenario-document/v1"`);
  }
  if (doc.schemaVersion !== 1) {
    report.error("unsupported-schema-version", "/schemaVersion", `unsupported schemaVersion ${doc.schemaVersion}; this runtime supports 1`);
  }
  if (doc.id === "") report.error("invalid-shape", "/id", "id is required");
  if (doc.version === "") report.error("invalid-shape", "/version", "version is required");
  if (doc.title === "") report.error("invalid-shape", "/title", "title is required");
}

/**
 * Checks every `Document.requires` entry against this runtime's supported
 * capability vocabulary — `"ai-goal"` and `"exampleBot:<id>"` for `id` in
 * {@link DEFAULT_SUPPORTED_EXAMPLE_BOTS} — rejecting an unrecognised entry by
 * naming it explicitly. Capabilities this format reserves but does not
 * support in v1 (`"deterministic"`, `"multi-chat"`, `"hybrid"`, ...) are
 * rejected here the same way as any other unrecognised string.
 */
function validateRequires(doc: Document, report: ReportBuilder): void {
  (doc.requires ?? []).forEach((r, i) => {
    const pointer = `/requires/${i}`;
    if (r === "ai-goal") return;
    if (r.startsWith("exampleBot:")) {
      const name = r.slice("exampleBot:".length);
      if (DEFAULT_SUPPORTED_EXAMPLE_BOTS.has(name)) return;
      report.error("unsupported-capability", pointer, `unsupported capability "${r}": this runtime ships no example bot named "${name}"`);
      return;
    }
    report.error("unsupported-capability", pointer, `unsupported capability "${r}"`);
  });
}

function validatePlatform(doc: Document, report: ReportBuilder): void {
  if (doc.platform !== "telegram") {
    report.error("unsupported-capability", "/platform", `unsupported platform "${doc.platform}"; this runtime supports "telegram"`);
  }
}

/**
 * Enforces "exactly one chat in v1" (more than one is rejected as
 * `unsupported-capability: multi-chat`) and unique chat ids, returning the
 * set of declared doc-local chat ids for later reference-resolution checks.
 */
function validateChats(doc: Document, report: ReportBuilder): Set<string> {
  const ids = new Set<string>();
  if (doc.chats.length === 0) {
    report.error("invalid-shape", "/chats", "at least one chat is required");
  } else if (doc.chats.length > 1) {
    report.error("unsupported-capability", "/chats", 'unsupported capability "multi-chat": exactly one chat is supported in v1');
  }
  doc.chats.forEach((c, i) => {
    const pointer = `/chats/${i}`;
    if (c.id === "") {
      report.error("invalid-shape", `${pointer}/id`, "chat id is required");
      return;
    }
    if (ids.has(c.id)) report.error("duplicate-id", `${pointer}/id`, "duplicate chat id");
    ids.add(c.id);
  });
  return ids;
}

/**
 * Enforces the format README's "The bot endpoint" rules: exactly one of
 * `url`/`exampleBot`, transport/delivery/url combinations, and — the
 * runtime-ts-specific half of `unsupported-transport-is-refused-by-name` —
 * `transport: "http"` being unsupported here (no inbound server surface)
 * while `"iframe"` IS supported (the mirror image of `runtime-go`).
 */
function validateBot(doc: Document, report: ReportBuilder): void {
  const b: Bot = doc.bot;
  if (b.id === "") report.error("invalid-shape", "/bot/id", "bot id is required");
  if (b.name === "") report.error("invalid-shape", "/bot/name", "bot name is required");

  const hasUrl = b.url !== undefined && b.url !== "";
  const hasExampleBot = b.exampleBot !== undefined && b.exampleBot !== "";
  if (hasUrl === hasExampleBot) {
    report.error("invalid-shape", "/bot", 'exactly one of "url" or "exampleBot" is required');
    return;
  }
  if (hasExampleBot) {
    if (b.transport !== undefined && b.transport !== "") report.error("invalid-shape", "/bot/transport", "transport is forbidden with exampleBot");
    if (b.delivery !== undefined && b.delivery !== "") report.error("invalid-shape", "/bot/delivery", "delivery is forbidden with exampleBot");
    const required = `exampleBot:${b.exampleBot}`;
    if (!(doc.requires ?? []).includes(required)) {
      report.error("invalid-shape", "/requires", `using exampleBot "${b.exampleBot}" requires declaring "${required}" in "requires"`);
    }
    return;
  }

  // hasUrl: transport is required. runtime-ts refuses "http" by name (a
  // browser page has no inbound HTTP server surface — see
  // docs/runtime-parity.md: "Remote bots ... Blocked") and accepts
  // "iframe" (✅ Works — IframeHost). This is the exact mirror of
  // runtime-go's validateBot, which accepts "http" and refuses "iframe" by
  // name — see the unsupported-transport-is-refused-by-name AC: "the same
  // refusal shape applies to runtime-go given transport: iframe".
  switch (b.transport) {
    case undefined:
    case "":
      report.error("invalid-shape", "/bot/transport", "transport is required with url");
      break;
    case "http":
      report.error(
        "unsupported-transport",
        "/bot/transport",
        'unsupported transport "http": runtime-ts has no inbound HTTP server surface (⛔ Blocked — see docs/runtime-parity.md)',
      );
      break;
    case "iframe":
      if (b.delivery !== undefined && b.delivery !== "") {
        report.error("invalid-shape", "/bot/delivery", "delivery is forbidden with iframe transport");
      }
      break;
    default:
      report.error("invalid-shape", "/bot/transport", `unrecognised transport "${b.transport}"`);
  }
}

/**
 * Enforces cast-member id uniqueness, type/provider consistency and
 * provider-kind shape, returning a lookup from cast id to its `type` for
 * {@link validateParts}' `actorId`/goal-actor checks.
 */
function validateCast(doc: Document, report: ReportBuilder): Map<string, string> {
  const byId = new Map<string, string>();
  if (doc.cast.length === 0) report.error("invalid-shape", "/cast", "at least one cast member is required");

  doc.cast.forEach((c: Cast, i) => {
    const pointer = `/cast/${i}`;
    if (c.id === "") {
      report.error("invalid-shape", `${pointer}/id`, "cast id is required");
    } else {
      if (byId.has(c.id)) report.error("duplicate-id", `${pointer}/id`, "duplicate cast id");
      byId.set(c.id, c.type);
    }

    switch (c.type) {
      case "ai-agent":
        if (c.provider === undefined) {
          report.error("invalid-shape", `${pointer}/provider`, "an ai-agent cast member requires a provider");
        } else {
          validateProvider(c.provider, `${pointer}/provider`, report);
        }
        break;
      case "human":
        if (c.provider !== undefined) report.error("invalid-shape", `${pointer}/provider`, "a human cast member declares no provider");
        break;
      default:
        report.error("invalid-shape", `${pointer}/type`, `unrecognised cast type "${c.type}"`);
    }
  });
  return byId;
}

function validateProvider(p: NonNullable<Cast["provider"]>, pointer: string, report: ReportBuilder): void {
  switch (p.kind) {
    case "model":
      if (p.model === undefined || p.model === "") report.error("invalid-shape", `${pointer}/model`, "model is required for a model provider");
      if (p.providerId === undefined || p.providerId === "") report.error("invalid-shape", `${pointer}/providerId`, "providerId is required for a model provider");
      break;
    case "cassette":
      if (p.cassette === undefined || p.cassette === "") report.error("invalid-shape", `${pointer}/cassette`, "cassette is required for a cassette provider");
      switch (p.mode) {
        case "replay":
          if (p.wraps !== undefined) report.error("invalid-shape", `${pointer}/wraps`, "wraps is forbidden in replay mode");
          break;
        case "record":
          if (p.wraps === undefined) {
            report.error("invalid-shape", `${pointer}/wraps`, "record mode requires wraps (a model provider)");
          } else if (p.wraps.kind !== "model") {
            report.error("invalid-shape", `${pointer}/wraps/kind`, "wraps must be a model provider");
          } else {
            validateProvider(p.wraps, `${pointer}/wraps`, report);
          }
          break;
        default:
          report.error("invalid-shape", `${pointer}/mode`, `unrecognised cassette mode "${p.mode}"`);
      }
      break;
    default:
      report.error("invalid-shape", `${pointer}/kind`, `unrecognised provider kind "${p.kind}"`);
  }
}

/**
 * Enforces part-id uniqueness, chat/actorId reference resolution, the
 * deterministic-part-is-reserved rule, and delegates ai-goal budget/goal
 * validation to {@link validateGoalPart}.
 */
function validateParts(doc: Document, report: ReportBuilder, chatIds: ReadonlySet<string>, castById: ReadonlyMap<string, string>): void {
  if (doc.parts.length === 0) report.error("invalid-shape", "/parts", "at least one part is required");

  const seen = new Set<string>();
  doc.parts.forEach((p: DocumentPart, i) => {
    const pointer = `/parts/${i}`;
    if (p.id === "") {
      report.error("invalid-shape", `${pointer}/id`, "part id is required");
    } else {
      if (seen.has(p.id)) report.error("duplicate-id", `${pointer}/id`, "duplicate part id");
      seen.add(p.id);
    }

    if (p.chat === "") {
      report.error("invalid-shape", `${pointer}/chat`, "chat is required");
    } else if (!chatIds.has(p.chat)) {
      report.error("chat-ref-unresolved", `${pointer}/chat`, `chat "${p.chat}" does not resolve to a declared chats[].id`);
    }

    const failurePolicies: readonly string[] = ["", "abort", "coverage-gap"] satisfies readonly (DocumentFailurePolicy | "")[];
    if (p.failurePolicy !== undefined && !failurePolicies.includes(p.failurePolicy)) {
      report.error("invalid-shape", `${pointer}/failurePolicy`, `unrecognised failurePolicy "${p.failurePolicy}"`);
    }

    switch (p.kind) {
      case "ai-goal":
        validateGoalPart(p, pointer, report, castById);
        break;
      case "deterministic":
        report.error("unsupported-capability", `${pointer}/kind`, 'unsupported capability "deterministic-steps": deterministic parts are reserved for action matchers and not built');
        break;
      default:
        report.error("invalid-shape", `${pointer}/kind`, `unrecognised part kind "${p.kind}"`);
    }
  });
}

function validateGoalPart(p: DocumentPart, pointer: string, report: ReportBuilder, castById: ReadonlyMap<string, string>): void {
  if (p.actorId === "") {
    report.error("invalid-shape", `${pointer}/actorId`, "actorId is required");
  } else if (!castById.has(p.actorId)) {
    report.error("actor-ref-unresolved", `${pointer}/actorId`, `actorId "${p.actorId}" does not resolve to a declared cast[].id`);
  } else if (castById.get(p.actorId) !== "ai-agent") {
    report.error("invalid-shape", `${pointer}/actorId`, `actorId "${p.actorId}" resolves to a "${castById.get(p.actorId)}" cast member, not an ai-agent`);
  }

  if (p.goal === undefined) {
    report.error("invalid-shape", `${pointer}/goal`, "an ai-goal part requires goal");
    return;
  }

  if (!hasPositiveBudget(p.goal.budgets)) {
    report.error(
      "ai-goal-budgets-required",
      `${pointer}/goal/budgets`,
      "an ai-goal part's budgets must declare at least one positive bound (maxSteps, maxDurationSeconds or maxCost)",
    );
  }
  if ((p.goal.budgets.maxDurationSeconds ?? 0) < 0) report.error("invalid-shape", `${pointer}/goal/budgets/maxDurationSeconds`, "must not be negative");
  if ((p.goal.budgets.maxSteps ?? 0) < 0) report.error("invalid-shape", `${pointer}/goal/budgets/maxSteps`, "must not be negative");
  if (p.goal.budgets.maxCost !== undefined && p.goal.budgets.maxCost <= 0) report.error("invalid-shape", `${pointer}/goal/budgets/maxCost`, "must be positive when set");

  try {
    validateGoal(toRuntimeGoal(p.goal));
  } catch (err) {
    report.error("invalid-shape", `${pointer}/goal`, err instanceof GoalError ? err.message : errMessage(err));
  }
}

/** Reports whether `b` declares at least one positive bound — the ai-goal-part-without-budgets-is-rejected acceptance criterion. */
function hasPositiveBudget(b: DocumentBudgets): boolean {
  return (b.maxSteps ?? 0) > 0 || (b.maxDurationSeconds ?? 0) > 0 || (b.maxCost !== undefined && b.maxCost > 0);
}

/**
 * Converts an authored {@link DocumentGoal} to the runtime's own `Goal` shape
 * (seconds -> milliseconds), so this module's own goal-shape checks reuse
 * `../goal/goal.js`'s `validateGoal` (dependency-cycle detection,
 * duplicate-task-id detection) rather than re-implementing them — mirrors
 * `runtime-go`'s `toGoalGoal`, which does the identical conversion so Go's
 * own `goal.Goal.Validate` can be reused the same way.
 */
export function toRuntimeGoal(g: DocumentGoal): RuntimeGoal {
  const tasks: RuntimeTask[] = g.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    dependsOn: t.dependsOn,
    successCriteria: t.successCriteria,
    milestones: t.milestones,
  }));
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    tasks,
    constraints: g.constraints,
    budgets: {
      maxSteps: g.budgets.maxSteps,
      maxDurationMs: (g.budgets.maxDurationSeconds ?? 0) * 1000,
      maxCost: g.budgets.maxCost,
    },
  };
}

function validateCeiling(doc: Document, report: ReportBuilder): void {
  if (doc.ceiling === undefined) {
    report.warning("no-run-ceiling", "/ceiling", "no run-level ceiling is declared; only each part's own budgets bind");
    return;
  }
  const c = doc.ceiling;
  if ((c.maxSteps ?? 0) < 0) report.error("invalid-shape", "/ceiling/maxSteps", "must not be negative");
  if ((c.maxDurationSeconds ?? 0) < 0) report.error("invalid-shape", "/ceiling/maxDurationSeconds", "must not be negative");
  if (c.maxCost !== undefined && c.maxCost <= 0) report.error("invalid-shape", "/ceiling/maxCost", "must be positive when set");
}

/**
 * Rejects the RE2 ∩ JavaScript subset's known escape hatches —
 * backreferences and lookaround — that this runtime's own `RegExp` engine
 * (unlike Go's RE2-based `regexp` package) would otherwise happily compile,
 * so a pattern rejected here is rejected the same way in both runtimes
 * rather than only failing at replay time in whichever runtime is stricter.
 */
const LOOKAROUND_OR_BACKREFERENCE_PATTERN = /\\[1-9]|\(\?[=!<]/;

/**
 * Enforces `Verify`'s shape: chat resolution, expectation-id uniqueness,
 * condition field/op vocabulary, `contains`/`regex` forbidden on a
 * non-string field, and the RE2 ∩ JavaScript regex subset.
 */
function validateVerify(doc: Document, report: ReportBuilder, chatIds: ReadonlySet<string>): void {
  if (doc.verify === undefined) {
    report.warning("no-independent-verification", "/verify", "no independent journal verification is declared; a successful outcome is judged, never verified");
    return;
  }
  const v = doc.verify;
  if (v.chat === "") {
    report.error("invalid-shape", "/verify/chat", "chat is required");
  } else if (!chatIds.has(v.chat)) {
    report.error("chat-ref-unresolved", "/verify/chat", `chat "${v.chat}" does not resolve to a declared chats[].id`);
  }

  const seen = new Set<string>();
  v.journal.forEach((exp, i) => {
    const pointer = `/verify/journal/${i}`;
    if (exp.id === "") {
      report.error("invalid-shape", `${pointer}/id`, "expectation id is required");
    } else {
      if (seen.has(exp.id)) report.error("duplicate-id", `${pointer}/id`, "duplicate expectation id");
      seen.add(exp.id);
    }
    if (exp.all.length === 0) report.error("invalid-shape", `${pointer}/all`, "at least one condition is required");
    exp.all.forEach((cond, j) => validateCondition(cond, `${pointer}/all/${j}`, report));
  });
}

function validateCondition(c: Condition, pointer: string, report: ReportBuilder): void {
  let validField = true;
  const fields: readonly string[] = ["kind", "direction", "text", "edited"];
  if (!fields.includes(c.field)) {
    validField = false;
    report.error("invalid-shape", `${pointer}/field`, `unrecognised field "${c.field}"`);
  }

  switch (c.op) {
    case "exact":
      break;
    case "contains":
    case "regex":
      if (c.field === "edited") {
        report.error("invalid-shape", `${pointer}/op`, `op "${c.op}" is not permitted on boolean field "${c.field}"`);
      }
      break;
    default:
      report.error("invalid-shape", `${pointer}/op`, `unrecognised op "${c.op}"`);
  }

  if (!validField) return; // c.field's own shape (bool vs string) is unknown; nothing more to check about value.

  if (c.field === "edited") {
    if (typeof c.value !== "boolean") {
      report.error("invalid-shape", `${pointer}/value`, 'a condition on "edited" requires a boolean value');
    }
  } else if (c.op === "regex") {
    if (typeof c.value !== "string") {
      report.error("invalid-shape", `${pointer}/value`, "regex op requires a single string pattern");
    } else if (LOOKAROUND_OR_BACKREFERENCE_PATTERN.test(c.value)) {
      report.error("regex-unsupported-subset", `${pointer}/value`, "pattern uses backreferences or lookaround, outside the RE2 ∩ JavaScript subset this format supports");
    } else {
      try {
        new RegExp(c.value);
      } catch {
        report.error("regex-unsupported-subset", `${pointer}/value`, "pattern does not compile as a JavaScript RegExp");
      }
    }
  } else if (c.op === "exact" || c.op === "contains") {
    // exact/contains accept a single string or an array of strings (any-of).
    const okString = typeof c.value === "string";
    const okStringArray = Array.isArray(c.value) && c.value.every((v) => typeof v === "string");
    if (!okString && !okStringArray) {
      report.error("invalid-shape", `${pointer}/value`, `op "${c.op}" requires a string or an array of strings`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-exported for callers that only need the data-sensitivity vocabulary
// alongside validation (e.g. a Studio form) without importing document.ts
// directly.
export type { DataSensitivity };

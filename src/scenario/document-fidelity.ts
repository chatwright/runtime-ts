/**
 * Declared-fidelity validation and resolution — ported from `runtime-go`'s
 * `scenario/fidelity.go`.
 */

import type { Document, DataSensitivity, DocumentEnvironment, EndpointProfile } from "./document.js";
import type { ReportBuilder } from "./issues.js";

/**
 * Enforces the format README's "Declared fidelity and environment" rules
 * that are checkable from the document alone (endpoint
 * profile/environment/data-sensitivity vocabulary, and the
 * real-subject-requires-a-redaction-policy rule). The environment-default
 * heuristic (an unrecognised host resolving to `"unknown"`, production
 * defaulting sensitivity to `"real-subject"`) is applied later, by
 * {@link resolveFidelity} — not part of validation, because "what was
 * declared" and "what is effective" are different questions.
 */
export function validateFidelity(doc: Document, report: ReportBuilder): void {
  const f = doc.fidelity;
  const endpointProfiles: readonly string[] = ["platform-emulated", "headless-engine"] satisfies readonly EndpointProfile[];
  if (!endpointProfiles.includes(f.endpointProfile)) {
    report.error("invalid-shape", "/fidelity/endpointProfile", `unrecognised endpointProfile "${f.endpointProfile}"`);
  }

  const environments: readonly string[] = ["dev", "test", "production", "unknown"] satisfies readonly DocumentEnvironment[];
  if (f.environment !== undefined && f.environment !== "" && !environments.includes(f.environment)) {
    report.error("invalid-shape", "/fidelity/environment", `unrecognised environment "${f.environment}"`);
  }

  const sensitivities: readonly string[] = ["synthetic", "real-subject"] satisfies readonly DataSensitivity[];
  if (f.dataSensitivity !== undefined && f.dataSensitivity !== "" && !sensitivities.includes(f.dataSensitivity)) {
    report.error("invalid-shape", "/fidelity/dataSensitivity", `unrecognised dataSensitivity "${f.dataSensitivity}"`);
  }

  if (f.dataSensitivity === "real-subject" && (f.redactionPolicy ?? "").trim() === "") {
    report.error(
      "redaction-policy-required",
      "/fidelity/redactionPolicy",
      'dataSensitivity "real-subject" requires a declared redactionPolicy',
    );
  }
  // A document declaring real-subject on a non-production environment is
  // accepted as-is (never overridden back to synthetic) — see the format
  // README: "real-subject may be declared on a test endpoint, which is the
  // case that leaks in silence otherwise".
}

/**
 * `doc.fidelity` with every default the format README's "Declared fidelity
 * and environment" section describes actually applied — what a caller
 * (Build, a report) should show as "what this run's fidelity actually is",
 * as opposed to {@link Document.fidelity}, which shows only what the author
 * explicitly wrote.
 */
export interface ResolvedFidelity {
  readonly endpointProfile: string;
  /** `doc.fidelity.environment` when declared; otherwise the unambiguous-host heuristic; otherwise `"unknown"` — never guessed beyond that. */
  readonly environment: string;
  /** `doc.fidelity.dataSensitivity` when declared; otherwise `"real-subject"` when `environment` is `"production"`; otherwise `"synthetic"`. */
  readonly dataSensitivity: string;
}

/**
 * Applies the format README's declared-then-configured-then-heuristic
 * resolution order for environment, and the environment-defaults-sensitivity
 * rule, to `doc` — a pure function (no network access) kept separate from
 * validation because it needs `doc.bot.url`, which is meaningless to resolve
 * for an `exampleBot` document (there is no host to inspect).
 */
export function resolveFidelity(doc: Document): ResolvedFidelity {
  const f = doc.fidelity;
  const environment = f.environment !== undefined && f.environment !== "" ? f.environment : environmentForHost(doc.bot.url);

  let dataSensitivity = f.dataSensitivity;
  if (dataSensitivity === undefined || dataSensitivity === "") {
    dataSensitivity = environment === "production" ? "real-subject" : "synthetic";
  }

  return { endpointProfile: f.endpointProfile, environment, dataSensitivity };
}

/**
 * Applies the format README's "unambiguous hosts" heuristic (`localhost`,
 * `127.0.0.1`, `*.localhost` -> `"dev"`) to `rawUrl`'s host, or `"unknown"`
 * for an empty/unparsable/unrecognised host — an `exampleBot` document (no
 * `bot.url` at all) always resolves to `"unknown"` here, which is why the
 * worked-example greetbot document declares `"environment": "dev"` explicitly
 * rather than relying on this heuristic.
 */
function environmentForHost(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl === "") return "unknown";
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return "unknown";
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return "dev";
  return "unknown";
}

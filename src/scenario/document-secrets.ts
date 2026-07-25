/**
 * Secret-shape and credential-bearing-URL scans over a scenario document's
 * generic JSON tree — ported from `runtime-go`'s `scenario/secrets.go`. Run
 * *before* any typed decode, exactly as Go runs them, so a rejection can name
 * a precise JSON pointer without depending on the strict {@link
 * "./document.js".Document} shape having decoded successfully, and so every
 * message is built from this module's own literals, never from a
 * document-supplied value (the format README's "never echoes the value"
 * rule).
 */

import { escapePointerToken, sortedKeys, type JsonObject } from "./document-json.js";
import type { ReportBuilder } from "./issues.js";

/**
 * The case/underscore-insensitive set of query parameter names that make a
 * URL credential-bearing — see the format README's secrets rule 4.
 * {@link normalizeParamName} folds a name to this set's own canonical form
 * before comparing.
 */
const CREDENTIAL_QUERY_PARAM_NAMES = new Set([
  "token",
  "apikey",
  "accesstoken",
  "key",
  "password",
  "secret",
  "signature",
]);

function normalizeParamName(name: string): string {
  return name.toLowerCase().replaceAll("_", "");
}

/**
 * Validates the document's top-level `secrets` member — each entry's `name`
 * and its `from` source (exactly one of `{"env"}` or `{"credential"}`, no
 * other member) — and returns the set of declared secret names. A malformed
 * entry is reported against its own pointer; scanning continues past one bad
 * entry.
 */
export function scanSecretsArray(root: JsonObject, report: ReportBuilder): Set<string> {
  const declared = new Set<string>();
  const raw = root["secrets"];
  if (raw === undefined) return declared;
  if (!Array.isArray(raw)) {
    report.error("invalid-shape", "/secrets", "secrets must be an array");
    return declared;
  }

  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const pointer = `/secrets/${i}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      report.error("invalid-shape", pointer, "each secret must be an object");
      return;
    }
    const obj = item as JsonObject;
    const name = typeof obj["name"] === "string" ? obj["name"] : "";
    if (name === "") {
      report.error("invalid-shape", `${pointer}/name`, "secret name is required and must be a non-empty string");
    } else {
      if (seen.has(name)) report.error("duplicate-id", `${pointer}/name`, "duplicate secret name");
      seen.add(name);
      declared.add(name);
    }
    validateSecretSource(obj["from"], `${pointer}/from`, report);
  });
  return declared;
}

/** Enforces `SecretSource`'s shape: exactly one of `env`/`credential`, each a non-empty string, no other member (no `value`, `default` or `fallback`). */
function validateSecretSource(raw: unknown, pointer: string, report: ReportBuilder): void {
  if (raw === undefined || raw === null) {
    report.error("secret-source-shape", pointer, '"from" is required');
    return;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report.error("secret-source-shape", pointer, '"from" must be an object');
    return;
  }
  const obj = raw as JsonObject;
  const hasEnv = Object.prototype.hasOwnProperty.call(obj, "env");
  const hasCred = Object.prototype.hasOwnProperty.call(obj, "credential");
  if (Object.keys(obj).length !== 1 || hasEnv === hasCred) {
    report.error(
      "secret-source-shape",
      pointer,
      'must be exactly one of {"env": "VAR"} or {"credential": "name"}, with no other member (no "value", "default" or "fallback")',
    );
    return;
  }
  if (hasEnv) {
    const v = obj["env"];
    if (typeof v !== "string" || v === "") report.error("secret-source-shape", `${pointer}/env`, "env must be a non-empty string");
  }
  if (hasCred) {
    const v = obj["credential"];
    if (typeof v !== "string" || v === "") report.error("secret-source-shape", `${pointer}/credential`, "credential must be a non-empty string");
  }
}

/**
 * Validates every field in the closed list of secret-bearing locations —
 * `bot.headers[*].value`, `cast[*].provider.apiKey` and
 * `cast[*].provider.wraps.apiKey` (the format README's secrets rule 1) — and
 * returns the secretRef names actually used, each mapped to every pointer
 * that used it (so {@link crossCheckSecretRefs} can report every offending
 * location, not just the first).
 */
export function scanSecretBearingFields(root: JsonObject, report: ReportBuilder): Map<string, string[]> {
  const used = new Map<string, string[]>();

  const bot = asObject(root["bot"]);
  if (bot !== undefined) {
    const headers = asObject(bot["headers"]);
    if (headers !== undefined) {
      for (const key of sortedKeys(headers)) {
        checkSecretRefShape(headers[key], `/bot/headers/${escapePointerToken(key)}`, report, used);
      }
    }
  }

  const cast = root["cast"];
  if (Array.isArray(cast)) {
    cast.forEach((item, i) => {
      const member = asObject(item);
      if (member === undefined) return;
      const provider = asObject(member["provider"]);
      if (provider === undefined) return;
      const base = `/cast/${i}/provider`;
      if (Object.prototype.hasOwnProperty.call(provider, "apiKey")) {
        checkSecretRefShape(provider["apiKey"], `${base}/apiKey`, report, used);
      }
      const wraps = asObject(provider["wraps"]);
      if (wraps !== undefined && Object.prototype.hasOwnProperty.call(wraps, "apiKey")) {
        checkSecretRefShape(wraps["apiKey"], `${base}/wraps/apiKey`, report, used);
      }
    });
  }

  return used;
}

/**
 * Enforces that `v` is exactly `{"secretRef": "<name>"}` — no sibling
 * member, no bare string literal, no other JSON type (the format README's
 * secrets rule 2). A literal string is reported as `"inline-secret"`
 * specifically (a stronger, more actionable diagnosis than the generic
 * shape-mismatch code); every other malformed shape is `"secret-ref-shape"`.
 * Neither message, nor any issue this function ever adds, includes `v`'s own
 * value.
 */
function checkSecretRefShape(v: unknown, pointer: string, report: ReportBuilder, used: Map<string, string[]>): void {
  if (typeof v === "string") {
    report.error(
      "inline-secret",
      pointer,
      'a literal value is not permitted here — this field must be {"secretRef": "<name>"}, referencing a name declared in "secrets"',
    );
    return;
  }
  const obj = asObject(v);
  if (obj === undefined) {
    report.error("secret-ref-shape", pointer, 'must be {"secretRef": "<name>"}');
    return;
  }
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    report.error("secret-ref-shape", pointer, 'must be exactly {"secretRef": "<name>"} with no other member');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, "secretRef")) {
    report.error("secret-ref-shape", pointer, 'must be {"secretRef": "<name>"}');
    return;
  }
  const name = obj["secretRef"];
  if (typeof name !== "string" || name === "") {
    report.error("secret-ref-shape", pointer, "secretRef must be a non-empty string naming a declared secret");
    return;
  }
  const pointers = used.get(name) ?? [];
  pointers.push(pointer);
  used.set(name, pointers);
}

/**
 * Rejects a secretRef naming an undeclared secret (the format README's
 * secrets rule 3, first half) and reports — never rejects — a declared
 * secret no field actually references (rule 3, second half).
 */
export function crossCheckSecretRefs(declared: Set<string>, used: Map<string, string[]>, report: ReportBuilder): void {
  for (const [name, pointers] of used) {
    if (declared.has(name)) continue;
    for (const pointer of pointers) {
      report.error("secret-ref-undeclared", pointer, "secretRef names a secret not declared in \"secrets\"");
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      report.warning("secret-declared-unused", "", `secret "${name}" is declared but never referenced by a secretRef`);
    }
  }
}

/**
 * Rejects a URL member (`bot.url`, `cast[*].provider.baseUrl`,
 * `cast[*].provider.wraps.baseUrl`) that carries userinfo or a
 * credential-shaped query parameter — the format README's secrets rule 4.
 * The offending URL is never echoed in the issue message.
 */
export function scanCredentialBearingURLs(root: JsonObject, report: ReportBuilder): void {
  const bot = asObject(root["bot"]);
  if (bot !== undefined && typeof bot["url"] === "string" && bot["url"] !== "") {
    checkURLForCredentials(bot["url"], "/bot/url", report);
  }

  const cast = root["cast"];
  if (Array.isArray(cast)) {
    cast.forEach((item, i) => {
      const member = asObject(item);
      if (member === undefined) return;
      const provider = asObject(member["provider"]);
      if (provider === undefined) return;
      const base = `/cast/${i}/provider`;
      if (typeof provider["baseUrl"] === "string" && provider["baseUrl"] !== "") {
        checkURLForCredentials(provider["baseUrl"], `${base}/baseUrl`, report);
      }
      const wraps = asObject(provider["wraps"]);
      if (wraps !== undefined && typeof wraps["baseUrl"] === "string" && wraps["baseUrl"] !== "") {
        checkURLForCredentials(wraps["baseUrl"], `${base}/wraps/baseUrl`, report);
      }
    });
  }
}

/**
 * Reports `raw` as credential-bearing when it carries userinfo
 * (`//user:pass@`) or a query parameter whose name normalises to one of
 * {@link CREDENTIAL_QUERY_PARAM_NAMES}. An unparsable URL is reported
 * separately (`invalid-url`) rather than silently passed through — it is
 * still rejected, just under a more accurate code.
 */
function checkURLForCredentials(raw: string, pointer: string, report: ReportBuilder): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    report.error("invalid-url", pointer, "value is not a valid URL");
    return;
  }
  if (u.username !== "" || u.password !== "") {
    report.error(
      "credential-bearing-url",
      pointer,
      "URL carries userinfo (user:pass@) credentials, which a scenario document may never contain",
    );
    return;
  }
  for (const param of u.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAM_NAMES.has(normalizeParamName(param))) {
      report.error(
        "credential-bearing-url",
        pointer,
        "URL carries a credential-shaped query parameter, which a scenario document may never contain",
      );
      return;
    }
  }
}

function asObject(v: unknown): JsonObject | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
}

/**
 * Resolves one declared {@link "./document.js".Secret}'s actual value at
 * Build time — the separate, explicit step parsing never reaches. Two
 * methods, not one, so a caller can support one source without pretending to
 * support the other.
 */
export interface SecretResolver {
  resolveEnv(varName: string): Promise<string> | string;
  resolveCredential(credentialName: string): Promise<string> | string;
}

/** Thrown by {@link EnvOnlySecretResolver.resolveCredential} for every credential name: this runtime has no credential store yet. */
export class CredentialStoreUnavailableError extends Error {
  constructor(credentialName: string) {
    super(`scenario: no credential store is configured in this runtime: ${credentialName}`);
    this.name = "CredentialStoreUnavailableError";
  }
}

/**
 * The default {@link SecretResolver}: `{"env": "VAR"}` secrets resolve via an
 * injected environment lookup (missing/empty is an error, never a silent
 * empty string standing in for a credential); `{"credential": "name"}`
 * secrets always fail with {@link CredentialStoreUnavailableError} — no
 * credential store exists yet in this runtime.
 *
 * @remarks
 * A browser page has no `process.env` — `lookup` defaults to reading
 * `globalThis.process?.env` (present under Node/vitest, absent in a browser),
 * so a browser caller MUST supply its own `lookup` (e.g. resolved secrets
 * from Studio's own configuration) rather than relying on this default.
 */
export class EnvOnlySecretResolver implements SecretResolver {
  constructor(private readonly lookup: (varName: string) => string | undefined = defaultEnvLookup) {}

  resolveEnv(varName: string): string {
    const v = this.lookup(varName);
    if (v === undefined || v === "") {
      throw new Error(`scenario: environment variable ${varName} is not set`);
    }
    return v;
  }

  resolveCredential(credentialName: string): never {
    throw new CredentialStoreUnavailableError(credentialName);
  }
}

function defaultEnvLookup(varName: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[varName];
}

/** Resolves one declared secret by name via `resolver`, given `doc`'s own `secrets` declarations. */
export async function resolveSecret(secrets: readonly { name: string; from: { env?: string; credential?: string } }[], resolver: SecretResolver, name: string): Promise<string> {
  const secret = secrets.find((s) => s.name === name);
  if (secret === undefined) throw new Error(`scenario: secret "${name}" is not declared`);
  if (secret.from.env !== undefined && secret.from.env !== "") return resolver.resolveEnv(secret.from.env);
  if (secret.from.credential !== undefined && secret.from.credential !== "") return resolver.resolveCredential(secret.from.credential);
  throw new Error(`scenario: secret "${name}" declares neither env nor credential`);
}

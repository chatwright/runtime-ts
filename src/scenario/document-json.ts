/**
 * Small, shared helpers for walking a scenario document's generic JSON tree
 * — used by every pre-decode scan (`document-secrets.ts`, `document-parse.ts`)
 * so every tree walk in this module family visits object members in the same
 * fixed, reproducible order and escapes JSON pointer segments identically.
 */

/** A plain JSON object as parsed by `JSON.parse` — no class instances, no `undefined` values by construction. */
export type JsonObject = Record<string, unknown>;

/** Type guard: `v` is a plain JSON object (not `null`, not an array). */
export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Returns `obj`'s keys sorted ascending, so every tree walk in this module
 * family visits (and therefore reports) object members in a fixed order —
 * mirrors `runtime-go`'s `sortedKeys`, which exists there to counter Go's own
 * randomised map iteration; kept here purely for cross-runtime determinism of
 * issue ordering.
 */
export function sortedKeys(obj: JsonObject): string[] {
  return Object.keys(obj).sort();
}

/** Escapes `s` per RFC 6901 for use as one JSON pointer path segment. */
export function escapePointerToken(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

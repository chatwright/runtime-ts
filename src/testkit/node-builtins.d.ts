/**
 * Minimal ambient declarations for the two Node.js built-in module exports
 * this package's tests use (reading the vendored run-bundle schema fixture
 * from disk). Deliberately hand-written instead of depending on
 * `@types/node`: the task that produced this package's first slice keeps
 * new devDependencies to `vitest` and `ajv` only. Extend this file if a
 * future test needs another Node built-in — do not reach for `@types/node`
 * without revisiting that constraint.
 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

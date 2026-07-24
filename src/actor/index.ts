/**
 * `actor` — the provider seam and loop-event contract the Chatwright actor
 * loop is built on, ported faithfully from the Go runtime's `actor` package.
 * The loop itself is a follow-up slice; this foundation exports the interfaces
 * it will consume.
 */

export * from "./provider.js";
export * from "./loop-event.js";
export * from "./scripted-provider.js";
export * from "./loop.js";

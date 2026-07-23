/**
 * `@chatwright/runtime` — the browser runtime of Chatwright.
 *
 * @remarks
 * Scaffold status: interfaces and protocol types only. See the package
 * README for what this package is and research items I-66..I-68 in
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/research/knowledge-platform.md | knowledge-platform.md}
 * for the design sessions that turn these seams into a working runtime.
 */

export * from "./protocol/envelope.js";
export * from "./transport/transport.js";
export * from "./platform/codec.js";
export * from "./journal/journal.js";
export * from "./runtime/runtime.js";

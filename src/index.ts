/**
 * `@chatwright/runtime` — the browser runtime of Chatwright.
 *
 * @remarks
 * First slice: the iframe transport (`IframeHost`), the Telegram codec
 * (text, inline buttons, edits), the WhatsApp codec (text only — no
 * interactive buttons, no edits; see `src/whatsapp/codec.ts`), the
 * `Session` orchestrator that ties them together and produces run-bundle v1
 * documents, and the `expect/` layer —
 * `chatOf`/`Chat`/`BotMessageExpectation` — the deterministic scenario verbs
 * (TS twin of `runtime-go`'s `cw` package). See the package README for the
 * fidelity list and research items I-66..I-68 in
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/research/knowledge-platform.md | knowledge-platform.md}
 * for what remains deliberately deferred.
 */

export * from "./protocol/envelope.js";
export * from "./protocol/iframe-host.js";
export * from "./transport/transport.js";
export * from "./platform/codec.js";
export * from "./journal/journal.js";
export * from "./journal/in-memory-journal.js";
export * from "./telegram/codec.js";
export * from "./whatsapp/codec.js";
export * from "./session/session.js";
export * from "./runtime/runtime.js";
export * from "./expect/chat.js";
export * from "./expect/bot-message.js";

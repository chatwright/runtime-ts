# `@chatwright/runtime`

The browser runtime of [Chatwright](https://chatwright.dev) — the
orchestrator embedded in the Studio Playground/player component, and the
second implementation of the runtime concept alongside
[`chatwright.dev/runtime`](https://github.com/chatwright/runtime-go) (Go).

Naming note: the repository is **runtime-ts** and the package is
**`@chatwright/runtime`** — repositories carry the language suffix because
they share one namespace; package names don't, because each registry is
already language-scoped. The Go sibling follows the same rule: repository
runtime-go, module `chatwright.dev/runtime`.

## Status: first slice — iframe transport + Telegram codec slice (text, inline buttons, edits)

This repository has moved past interfaces-only. Working, tested code now
exists for all three seams decision 0012 names, wired together by a
`Session` orchestrator:

- **`IframeHost`** ([`src/protocol/iframe-host.ts`](src/protocol/iframe-host.ts))
  — the host side of the iframe postMessage handshake: origin-validated
  hello/hello-ack, `MessagePort` handoff, ordered update queueing until
  handshake, session reset on a repeated hello, and call/result correlation.
- **`TelegramCodec`** ([`src/telegram/codec.ts`](src/telegram/codec.ts)) —
  builds `message`/`callback_query` updates and answers `sendMessage`,
  `editMessageText`, `answerCallbackQuery` and `getMe`; everything else
  returns Telegram's own `501` shape and journals an `"uncaptured"` entry.
  See [Fidelity](#fidelity) below for exactly what is and is not covered.
- **`InMemoryJournal`** ([`src/journal/in-memory-journal.ts`](src/journal/in-memory-journal.ts))
  — append-only, per-chat, with `subscribe()` and an injectable `Clock`.
- **`Session`** ([`src/session/session.ts`](src/session/session.ts)) — ties
  the three together: register one bot, `submitText`/`submitClick`, and
  `toBundle()` to produce a
  [run-bundle v1](https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json)
  document that validates against the schema.

Read [`docs/architecture.md`](docs/architecture.md) for the session model,
how the three seams fit together, the planned (not yet built) live-append
path into the Studio player, and exactly what remains deferred. Deep design
for what's *not* here yet still happens in dedicated sessions tracked as
research backlog items in
[`chatwright/chatwright`](https://github.com/chatwright/chatwright)'s
[`spec/research/knowledge-platform.md`](https://github.com/chatwright/chatwright/blob/main/spec/research/knowledge-platform.md):

- **I-66** — browser runtime internals beyond this slice: a multi-bot
  registry, scenario execution, request routing across bots, and how the
  player's rendering accepts a live, append-only journal instead of a
  finished bundle.
- **I-67** — platform emulation fidelity in TypeScript beyond this slice,
  and shared conformance fixtures proving parity with the Go emulator.
- **I-68** — the bot protocol envelope's full specification: error
  semantics, timeouts, port lifecycle, multi-chat routing, version
  negotiation, iframe `sandbox`/CSP attributes.

This package's progress against `runtime-go` is also tracked in the
cross-repo [runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
(decision 0015).

## Responsibilities

Once built out, the runtime embedded in the Playground/player component owns:

- **Scenario execution** — driving a scenario against one or more bots.
- **Bot registry** — tracking which bots are addressable and how.
- **Request routing** — getting a platform update to the right bot.
- **Response correlation** — matching a bot's method call back to the
  request that provoked it.
- **Platform emulation** — presenting a platform-native surface (Telegram
  first) to black-box bots.
- **Transport abstraction** — iframe vs remote HTTPS, one mental model.
- **Recording** — journalling every exchange as a side effect of routing.
- **Replay** — driving a recorded run back through the same seams.
- **State** — the append-only journal as ground truth.

## Bots are black boxes

Chatwright defines no generic bot API. A Telegram bot receives Telegram Bot
API updates and answers with Telegram Bot API method calls; a WhatsApp bot
speaks WhatsApp Cloud API payloads; and so on per platform. Chatwright owns
only the minimal routing envelope where a transport needs one — the payload
inside is always the platform's own wire format, opaque to Chatwright.

Two transports share that model, "point your bot at Chatwright":

- **Iframe + postMessage** — the runtime loads `<iframe src="bot-url">` and
  speaks to it with a handshake, a `MessagePort` handoff, and an envelope
  (`{id, kind, platform, payload}`) carrying platform-native JSON. The
  envelope shape is [`src/protocol/envelope.ts`](src/protocol/envelope.ts);
  the working host-side implementation is
  [`src/protocol/iframe-host.ts`](src/protocol/iframe-host.ts) (this slice).
- **Remote HTTPS** — the runtime exposes an emulated platform API base URL;
  the bot swaps its API root, registers a webhook or long-polls, and calls
  platform methods against the emulated server — exactly today's Go-runtime
  pattern, promoted to a public contract. Not implemented in this slice;
  `HttpTransport` remains a scaffold stub.

Full rationale lives in decision
[0012](https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md)
("Black-box bots over platform-native payloads; a browser runtime").

## Package layout

```
src/
  protocol/envelope.ts       the iframe postMessage envelope + PROTOCOL_VERSION
  protocol/iframe-host.ts    IframeHost: handshake, port management, call correlation
  transport/transport.ts     BotTransport interface; IframeTransport (delegates to IframeHost); HttpTransport stub
  platform/codec.ts          PlatformCodec interface (per-platform, Telegram first)
  telegram/codec.ts          TelegramCodec: builds updates, answers Bot API calls
  journal/journal.ts         Journal + JournalEntry interfaces, mirrors platform.JournalEntry
  journal/in-memory-journal.ts  InMemoryJournal + Clock/systemClock
  session/session.ts         Session orchestrator; toBundle() → run-bundle v1
  runtime/runtime.ts          ChatwrightRuntime orchestrator interface (still provisional, I-66)
  testkit/fake-bot.ts        test-only: drives the bot side of the protocol over a MessagePort
  index.ts                   re-exports
```

These are the three seams decision 0012 decomposes the Go emulator's
monolith into — platform codec, transport, journal + observation — plus the
envelope that ties transports together, `Session` that ties the seams
together for this slice, and `runtime/runtime.ts`'s still-provisional
`ChatwrightRuntime` interface for the fuller orchestrator I-66 will design.

## Shared contracts are formats, never code

Chatwright's cross-language contracts are language-independent formats:

- The [run-bundle v1 schema](https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json)
  — the wire contract this runtime produces. `runtime-ts` is now its second
  producer: `Session.toBundle()` assembles a document in the schema's
  camelCase wire shape, and `src/session/session.test.ts` validates a real
  scripted exchange's output against a vendored copy of the schema with
  ajv. This package still does not *generate* TypeScript types from the
  schema (decision 0012's "shared contracts are formats, never code");
  `toBundle()` returns `unknown` deliberately — see
  [`src/journal/journal.ts`](src/journal/journal.ts) for the live, in-memory
  journal shape this converges from.
- The bot-protocol envelope (this repository's `src/protocol/envelope.ts`,
  eventually promoted to a JSON Schema under `formats/` per I-68).
- `CHATWRIGHT.md` — the repository manifest format (decision
  [0013](https://github.com/chatwright/chatwright/blob/main/spec/decisions/0013-chatwright-md-federation.md)).

Conformance between the Go and TypeScript runtimes is proven by shared
fixtures, never by shared libraries.

## Fidelity

Fidelity is declared, never assumed (decision 0008): this is exactly what
this slice covers, checked directly against `src/telegram/codec.ts` and
`src/protocol/iframe-host.ts` — not an aspiration. See
[`docs/architecture.md`](docs/architecture.md) for the design behind each
row and the [runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
for how this compares to `runtime-go`.

**Bot API methods (bot → host, over the iframe transport):**

| Method | Status |
|---|---|
| `getMe` | **Supported.** Always the fixed identity (`id: 1`, `is_bot: true`, `first_name: "ChatwrightBot"`, `username: "chatwright_bot"`). |
| `sendMessage` | **Supported, validated.** `chat_id` and non-empty `text` are required (else a Telegram-shaped `400`); `reply_markup` inline keyboards are parsed and normalised into journal actions. |
| `editMessageText` | **Supported, validated.** `chat_id` and `message_id` are required; appends a new, versioned journal entry rather than mutating the original; keeps the existing keyboard when `reply_markup` is omitted; `400` if the target message isn't found. |
| `answerCallbackQuery` | **Acknowledged, no-op.** No journal entry — it produces no observable chat content. |
| `setWebhook`, `deleteWebhook`, `setMyCommands` | **Unsupported, errors (`501`).** Deliberately narrower than `runtime-go`, which acknowledges these as no-ops: the iframe transport has no webhook concept at all, so this codec does not special-case them. See `docs/architecture.md`. |
| Everything else (`sendPhoto`, `sendDocument`, `sendPoll`, `deleteMessage`, `pinChatMessage`, …) | **Unsupported, errors (`501`).** Returns `{"ok":false,"error_code":501,"description":"method not emulated: <method>"}` and journals an `"uncaptured"` entry — never silently swallowed. |

**Update types (host → bot):**

| Update | Status |
|---|---|
| `message` (plain text) | **Supported.** |
| `callback_query` (inline-keyboard click) | **Supported.** |
| `edited_message`, media messages, group/channel updates | **Not implemented** in this slice. |

**Transport and scope:**

| Capability | Status |
|---|---|
| Iframe + `postMessage` transport | **Supported** — handshake, ordered update queueing, session reset on repeated hello, call/result correlation. See `docs/architecture.md`. |
| Remote HTTPS transport | **Not implemented.** `HttpTransport` remains a scaffold stub. |
| Multiple bots per session | **Not implemented.** `Session.registerBot` supports exactly one bot; a second call throws. |
| Multiple chats per session | **Supported** — `Session` journals and bundles every `chatId` it is addressed with. |
| Group/channel chats | **Not implemented.** Every chat is built as Telegram `type: "private"`. |
| Run-bundle v1 output | **Supported for a single deterministic part.** `toBundle()` always emits one run with one `kind: "deterministic"` part spanning the whole journal; multi-part runs, AI-goal parts, bookmarks and annotations are not produced. |
| Live-append rendering (Studio player) | **Not implemented.** `Journal.subscribe()` is the seam; wiring it to the player is deferred to I-66 — see `docs/architecture.md`. |

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## License

Apache-2.0. See [LICENSE](LICENSE).

Chatwright is an independent open-source project developed by
[Sneat.co](https://sneat.co).

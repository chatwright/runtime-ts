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

## Status: iframe transport + Telegram & WhatsApp codecs + deterministic expect layer

This repository has moved past interfaces-only. Working, tested code now
exists for all three seams decision 0012 names, wired together by a
`Session` orchestrator, plus a deterministic scenario-verb layer on top of it:

- **`IframeHost`** ([`src/protocol/iframe-host.ts`](src/protocol/iframe-host.ts))
  — the host side of the iframe postMessage handshake: origin-validated
  hello/hello-ack, `MessagePort` handoff, ordered update queueing until
  handshake, session reset on a repeated hello, and call/result correlation.
- **`TelegramCodec`** ([`src/telegram/codec.ts`](src/telegram/codec.ts)) —
  builds `message`/`callback_query` updates and answers `sendMessage`,
  `editMessageText`, `answerCallbackQuery` and `getMe`; everything else
  returns Telegram's own `501` shape and journals an `"uncaptured"` entry.
  See [Fidelity](#fidelity) below for exactly what is and is not covered.
- **`WhatsAppCodec`** ([`src/whatsapp/codec.ts`](src/whatsapp/codec.ts)) —
  the runtime's second platform codec, following the same
  [`PlatformCodec`](src/platform/codec.ts) seam: builds `messages` webhook
  updates and answers a `"sendMessage"` call carrying `type: "text"`;
  everything else returns the WhatsApp Cloud API's own `{"error": {...}}`
  shape and journals an `"uncaptured"` entry. **Text only — no interactive
  buttons, no message edits** (WhatsApp's Cloud API has no edit endpoint at
  all); see [Fidelity](#fidelity) below and the capability data and
  [runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
  for exactly what that means.
- **`InMemoryJournal`** ([`src/journal/in-memory-journal.ts`](src/journal/in-memory-journal.ts))
  — append-only, per-chat, with `subscribe()` and an injectable `Clock`.
- **`Session`** ([`src/session/session.ts`](src/session/session.ts)) — ties
  the three together: register one bot, `submitText`/`submitClick`, and
  `toBundle()` to produce a
  [run-bundle v1](https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json)
  document that validates against the schema. Codec-agnostic: it drives
  whichever [`PlatformCodec`](src/platform/codec.ts) `SessionOptions.codec`
  supplies (Telegram by default, WhatsApp via `new WhatsAppCodec(...)`) —
  `platform` and every `platformIdentities` key in the bundle it produces
  come from that codec, never a hardcoded string.
- **`chatOf`/`Chat`/`BotMessageExpectation`** ([`src/expect/`](src/expect/))
  — the deterministic expect layer: a PlaygroundChat-style handle
  (`sendText`, `click`, `expectBotMessage`, `expectEdited`) built on
  `Session`'s journal via subscribe-based waiting (never polling), with a
  per-chat consumption cursor and transcript-bearing failures — the
  TypeScript twin of `runtime-go`'s `cw` package
  (`chatwright/runtime-go/cw/{chat,expect}.go`), ported as an algorithm per
  decision 0012. See [Fidelity](#fidelity) below and
  [`docs/architecture.md`](docs/architecture.md#the-expect-layer--deterministic-scenario-verbs)
  for the full deviation list versus Go.

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
  whatsapp/codec.ts          WhatsAppCodec: builds webhook updates, answers sendMessage (text only)
  journal/journal.ts         Journal + JournalEntry interfaces, mirrors platform.JournalEntry
  journal/in-memory-journal.ts  InMemoryJournal + Clock/systemClock
  session/session.ts         Session orchestrator; toBundle() → run-bundle v1
  runtime/runtime.ts          ChatwrightRuntime orchestrator interface (still provisional, I-66)
  expect/chat.ts              Chat + chatOf(): sendText/click/expectBotMessage/expectEdited, the consumption cursor
  expect/bot-message.ts       BotMessageExpectation: text/expectText/expectActions/within
  expect/wait.ts              subscribe-based waitForCondition() + the nth-outbound-message / latest-edit lookups
  expect/transcript.ts        renderTranscript(): the prose embedded in every expect-layer failure
  testkit/fake-bot.ts        test-only: drives the bot side of the protocol over a MessagePort
  index.ts                   re-exports
```

These are the three seams decision 0012 decomposes the Go emulator's
monolith into — platform codec, transport, journal + observation — plus the
envelope that ties transports together, `Session` that ties the seams
together for this slice, `expect/` that layers the deterministic scenario
verbs on top of `Session`, and `runtime/runtime.ts`'s still-provisional
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
this slice covers, checked directly against `src/telegram/codec.ts`,
`src/whatsapp/codec.ts`, `src/protocol/iframe-host.ts` and `src/expect/` —
not an aspiration. See [`docs/architecture.md`](docs/architecture.md) for
the design behind each row and the
[runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
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

**WhatsApp Cloud API calls (bot → host, over the iframe transport):**

**No buttons, no edits — this is a deliberately text-only slice.** WhatsApp's
`capabilities` list is exactly `["messaging.text"]` — no
`messaging.buttons.inline`, no `messaging.message.edit` — matching the Go
emulator's own "MVP-scope, text-first" package doc. See the capability data
in `chatwright/recipes` (`data/capabilities/messaging.text.json`,
`messaging.buttons.inline.json`, `messaging.message.edit.json`) and the
[runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
for the authoritative, machine-checkable statement of this — not this
table's prose.

| Call | Status |
|---|---|
| `sendMessage` with `params.type === "text"` | **Supported.** Journals a bot message entry and returns the Cloud API's success envelope (`{messaging_product, contacts, messages}`). |
| `sendMessage` with any other `type` (image, interactive, template, location, …) | **Unsupported, errors.** Returns the Cloud API's own `{"error": {"message","type","code","error_subcode","fbtrace_id"}}` shape (`type: "ChatwrightNotEmulated"`, `code: 501` — chatwright's own honesty marker, not a real Meta error) and journals an `"uncaptured"` entry. **Deliberately stricter here than `runtime-go`'s emulator**, which silently accepts any `/messages` POST as text — see `src/whatsapp/codec.ts`'s module doc comment for the full reasoning. |
| Any call whose `method` isn't `"sendMessage"` | **Unsupported, errors** — same shape as above. |
| Interactive-reply clicks, message edits | **Not implemented — no buttons, no edits.** No `buildCallbackUpdate` at all (WhatsApp has no free-form inline-keyboard equivalent to emulate over this transport in this slice) and no edit call (the Cloud API itself has no edit endpoint to emulate). `Session.submitClick` throws an honest error for this codec rather than silently no-op'ing. |

**WhatsApp update types (host → bot):**

| Update | Status |
|---|---|
| `messages` webhook change, `type: "text"` | **Supported.** |
| `messages` webhook change, any other type; status updates; interactive-reply webhooks | **Not implemented** in this slice. |

**Deterministic scenario verbs (`src/expect/`):**

| Capability | Status |
|---|---|
| `chatOf(session, chatId, user)` handle | **Supported.** PlaygroundChat-style: `sendText`, `click`, `expectBotMessage`, `expectEdited`. Aliased per `(session, chatId)` — repeated calls return the same handle, sharing its cursor — mirroring Go's `PrivateChat`. |
| Consumption cursor | **Supported, matches `runtime-go`'s `cw.Chat` exactly.** Each `expectBotMessage()` consumes the next not-yet-consumed outbound message to that chat, once, in order; `expectEdited()` targets a specific message identity (`messageId` + `version`) instead and never advances the cursor. |
| `expectBotMessage` / `expectEdited` waiting | **Supported, subscribe-based** (`Journal.subscribe`) — never polling. Default safety timeout 5s (`DEFAULT_SAFETY_TIMEOUT_MS`), overridable per call via `{timeoutMs}`. |
| `BotMessageExpectation` assertions | **Supported:** `text()` (getter), `expectText(want)`, `expectActions(...labels)` (exact set, row-major flattened, order-sensitive), `within(ms)`. |
| `within(ms)` latency budget | **Supported, but narrower than Go's `Within`.** Asserts against the latency already recorded when the message arrived ("after arrival"); unlike Go, it cannot retroactively extend how long `expectBotMessage`/`expectEdited` waited for that arrival — see `docs/architecture.md` for why. |
| Transcript-in-failure | **Supported.** Every thrown `Error` embeds a chronological chat transcript (`src/expect/transcript.ts`), ported as an algorithm from `runtime-go`'s `Emulator.Transcript`/`renderTranscript`. |
| `click(actionIdOrLabel)` | **Supported, but targets the chat's most recently resolved message**, not an explicit `(row, col)` coordinate the way Go's `BotMessage.ExpectAction(row, col).Click()` does — matches a Playground chat's UI model directly. Matches by action id (`callback_data`) first, then by visible label. |
| `ExpectNoMessage` equivalent | **Not implemented** in this slice. |
| Portable scenario file format | **Not implemented.** Scenarios are still written directly against the `Chat`/`BotMessageExpectation` API in TypeScript — see research item I-71. |

**Transport and scope:**

| Capability | Status |
|---|---|
| Iframe + `postMessage` transport | **Supported** — handshake, ordered update queueing, session reset on repeated hello, call/result correlation. See `docs/architecture.md`. |
| Remote HTTPS transport | **Not implemented.** `HttpTransport` remains a scaffold stub. |
| Multiple bots per session | **Not implemented.** `Session.registerBot` supports exactly one bot; a second call throws. |
| Multiple chats per session | **Supported** — `Session` journals and bundles every `chatId` it is addressed with. |
| Group/channel chats | **Not implemented.** Every Telegram chat is built as `type: "private"`; WhatsApp has no chat-type field on the wire at all — every update is simply addressed to one `wa_id`. |
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

## Spec-first

Chatwright is developed spec-first with [SpecScore](https://specscore.md/) —
product specs live in the [standard repository](https://github.com/chatwright/chatwright);
this repository's own specs live under [`spec/`](spec/README.md).

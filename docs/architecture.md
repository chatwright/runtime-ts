# `runtime-ts` architecture — first slice

**Status:** first real slice (iframe transport + Telegram codec: text, inline
buttons, edits). Everything below describes what is actually implemented in
`src/` today, not an aspiration — see [README.md](../README.md#fidelity)
for the fidelity list and [`docs/runtime-parity.md`](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
(decision 0015) for how this slice compares to `runtime-go`.

## Session model

[`Session`](../src/session/session.ts) is the orchestrator this slice ships.
One `Session` instance:

- Registers **exactly one bot** via `registerBot(transport)`, where
  `transport` is anything implementing [`BotTransport`](../src/transport/transport.ts)
  — in practice, an [`IframeHost`](../src/protocol/iframe-host.ts).
- Turns `submitText(chatId, user, text)` / `submitClick(chatId, user,
  actionId, targetMessageId)` calls into Telegram updates, delivered to the
  bot via the transport.
- Answers the bot's calls by handing them to
  [`TelegramCodec`](../src/telegram/codec.ts) and relaying the result back
  through the transport.
- Owns one [`InMemoryJournal`](../src/journal/in-memory-journal.ts) per chat
  id, lazily created the first time that chat is addressed.
- Assembles everything recorded so far into a run-bundle v1 document via
  `toBundle()`: one run, an actor roster (a human actor and a bot actor,
  each with a `telegram` platform identity once one has been observed), one
  chat entry per addressed chat, and **one deterministic part whose journal
  boundary spans the entire recording** — this slice does not yet split a
  run into multiple parts or attach an AI-goal part.

This is a deliberately small slice of what research item I-66 ("browser
runtime internals") will eventually design: a multi-bot registry, scenario
execution, request routing across bots, and replay are all out of scope
here — see "Deferred" below.

## The three seams, as implemented

Decision [0012](https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md)
decomposes the Go emulator's monolith into three seams. This slice
implements one working instance of each.

### 1. Protocol seam — `IframeHost`

[`src/protocol/iframe-host.ts`](../src/protocol/iframe-host.ts) implements
the host side of the handshake specified in
[`formats/bot-protocol/v1/README.md`](https://github.com/chatwright/chatwright/blob/main/formats/bot-protocol/v1/README.md):

- The bot speaks first: it posts a `hello` (carrying its declared
  capability keys); the host validates the message's origin against
  `expectedOrigin` and, only then, replies with a `hello-ack` carrying a
  freshly transferred `MessagePort`. All further traffic moves onto that
  port.
- Outbound `update` envelopes are queued, in order, until the handshake
  completes, then flushed over the new port in the same order.
- A repeated `hello` resets the session: the previous port is closed, any
  calls it had received but not yet answered are dropped (a subsequent
  `respond()` for one of them throws), and a new port is established.
- Calls are correlated by `id`: a `pendingCalls` map records every `call`
  envelope the bot has sent that has not yet been answered, so `respond(id,
  result)` can validate the id it is given and a session reset can discard
  stale bookkeeping cleanly.

**Two attachments, one implementation.** The constructor's second argument
is either a `{kind: "window", hostWindow, botWindow}` attachment (a real
`<iframe>`'s `contentWindow`, for production use) or a `{kind: "port",
port}` attachment (a bare `MessagePort`). The second is what makes this
package's tests DOM-free: Node's global `MessageChannel`/`MessagePort` are
structurally compatible with the DOM types this module is written against
(via this package's `tsconfig.json` `"DOM"` lib entry), so a test hands
`IframeHost` one end of a `new MessageChannel()` and a
[`FakeBot`](../src/testkit/fake-bot.ts) test helper drives the other end
exactly as a real iframe-hosted bot would — see "Testing" below.
`transport/transport.ts`'s `IframeTransport` is now a thin
`BotTransport`-shaped wrapper over `IframeHost`, kept for callers that think
in terms of "the iframe transport."

Building `IframeHost` correctly surfaced one scaffold defect worth
recording: `src/protocol/envelope.ts`'s `HelloMessage`/`HelloAckMessage`
had the handshake direction and `capabilities` placement backwards relative
to the normative protocol README (the scaffold's doc comments described the
*host* sending `hello` first and the bot's `hello-ack` carrying
capabilities). Both types are now corrected to match the README exactly:
the bot's `HelloMessage` carries `capabilities`; the host's `HelloAckMessage`
carries none.

### 2. Platform codec seam — `TelegramCodec`

[`src/telegram/codec.ts`](../src/telegram/codec.ts) builds and parses
Telegram Bot API payloads, porting `runtime-go`'s
[`telegram.Emulator`](https://github.com/chatwright/runtime-go/blob/main/telegram/emulator.go)
as an algorithm (never as shared code, per decision 0012):

- `buildTextUpdate`/`buildCallbackUpdate` build `message`/`callback_query`
  updates for user-originated events and journal the inbound entry, exactly
  mirroring `Emulator.SubmitText`/`SubmitClick` — including the id scheme:
  message ids come from a **per-chat** sequence shared by inbound and
  outbound messages; update ids come from one sequence shared across the
  whole codec instance (matching `Emulator.nextMsgID`/`nextUpdateID`
  exactly).
- `handleCall` parses and answers `sendMessage` (including `reply_markup`
  inline keyboards), `editMessageText` (appends a new, versioned journal
  entry rather than mutating the original — the append-only rule — and
  keeps the existing keyboard when `reply_markup` is omitted, like real
  Telegram), `answerCallbackQuery` (acknowledged, no journal entry — it
  produces no observable chat content), and `getMe`.
- Every other method returns the Telegram-shaped `501`
  (`{"ok":false,"error_code":501,"description":"method not emulated: X"}`)
  and journals an `"uncaptured"` entry attributed to whatever `chat_id` the
  call happened to carry (best-effort) — the same honesty rule as
  `Emulator.handleUnsupported`: an unrecognised call is surfaced, never
  silently swallowed.

**Deliberate narrowing versus `runtime-go`.** `Emulator` also
acknowledges `setWebhook`, `deleteWebhook` and `setMyCommands` as silent
no-ops, because a real bot library often calls the first two unconditionally
on startup regardless of delivery mode. The iframe transport has no webhook
concept at all — updates arrive over a `MessagePort`, never a webhook — so
`TelegramCodec` does not special-case those two; a bot that calls them sees
the same honest `501` as any other unemulated method. `setMyCommands` is
narrowed for the same consistency reason, not a technical one. This is
recorded as a deviation, not silently absorbed — see the fidelity list in
[README.md](../README.md#fidelity) and the cross-repo parity register.

The codec does not own journal storage itself: callers (in practice,
`Session`) resolve the right chat's `Journal` and pass it in, mirroring how
a real Bot API call's `chat_id` is what `Emulator` uses to route into its
own store.

### 3. Journal seam — `InMemoryJournal`

[`src/journal/in-memory-journal.ts`](../src/journal/in-memory-journal.ts)
is a minimal, append-only implementation of the scaffold's `Journal`
interface: `append` is the only way entries enter it (an edit is a new,
versioned entry, never a mutation), `entries()` returns everything recorded
so far, and `subscribe(listener)` notifies a listener of each entry as it
is appended — nothing is replayed retroactively to a new subscriber. One
`Session` owns one `InMemoryJournal` per chat id.

This module also introduces `Clock` (`() => Date`) and `systemClock`, the
injectable-clock convention every timestamp in this package now follows:
journal entry `at` fields and a bundle's `metadata.createdAt` all take a
`Clock` instead of calling `Date.now()`/`new Date()` directly, so tests can
supply a deterministic or monotonically-advancing clock.

## Planned live-append path into the Studio player (not implemented here)

The Studio player already has a deterministic, pure-fold rendering engine —
[`studio/src/app/player/engine/settled.ts`](https://github.com/chatwright/studio/blob/main/src/app/player/engine/settled.ts)'s
`SettledState` is explicitly documented as "a pure fold of the timeline's
journal steps up to and including that index" — but today it only ever
folds over a **finished** run-bundle document parsed by
`player/model/parse-bundle.ts`. Research item I-66 names the missing piece
directly: "how does the player's settled-fold rendering accept a live,
append-only journal instead of a finished bundle?", asking for "an
`appendStep`-style engine contract the existing player components can
consume."

This package's `Journal.subscribe(listener)` is the seam that path will
eventually hang off: a live `Session` driving a real, running bot already
produces exactly the incremental stream — one `JournalEntry` at a time,
in order — that an `appendStep`-shaped engine contract would consume
directly, without waiting for `toBundle()` to produce a finished document.
**None of that wiring exists yet.** Doing it properly needs its own design
session (I-66) covering at minimum: how a live `Session`'s per-chat
journals map onto the player's multi-chat timeline model, how the settled
fold's determinism guarantee is preserved when steps arrive one at a time
instead of all at once, and how a live session's `toBundle()` output and an
in-progress live-append stream stay consistent if a viewer switches between
"replay a finished run" and "watch a run happen."

## What stays deferred to I-66 / I-68

Explicitly out of scope for this slice, left to the named research items:

- **I-66** (browser runtime internals): a multi-bot registry, scenario
  execution beyond direct `submitText`/`submitClick` calls, request routing
  across more than one bot, response correlation across bots, and the live
  settled-fold wiring described above.
- **I-68** (bot protocol envelope, full specification): timeout and
  liveness semantics (an unresponsive bot's pending call sits in
  `pendingCalls` forever today), a transport-level error kind (today a
  malformed steady-port message is silently ignored rather than reported),
  multi-chat routing metadata beyond what payloads already carry,
  capability negotiation beyond declaration (a bot's declared
  `capabilities` are received but not yet acted on), protocol-version
  mismatch handling (`protocolVersion` is exchanged but never gated on),
  and iframe `sandbox`/CSP attributes.
- The remote-HTTPS transport (`HttpTransport`) remains an intentional
  scaffold stub — out of scope for this slice, which covers the iframe
  transport only.

## Testing

Every test in `src/**/*.test.ts` runs under [vitest](https://vitest.dev),
DOM-free, in plain Node:

- [`src/testkit/fake-bot.ts`](../src/testkit/fake-bot.ts) drives the bot
  side of the handshake and steady-state protocol over a raw
  `MessagePort` from Node's global `MessageChannel` — no `jsdom`, no
  browser. `MessagePort` message delivery is asynchronous (not observable
  synchronously or even within a microtask), so tests `await
  flushMacrotasks()` after every `postMessage` before asserting on its
  effect.
- [`src/session/__fixtures__/run-bundle.v1.schema.json`](../src/session/__fixtures__/run-bundle.v1.schema.json)
  is a vendored copy of
  [`formats/run-bundle/v1/schema.json`](https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json)
  (copied, not fetched, so CI does not depend on a sibling checkout).
  `src/session/session.test.ts` runs a scripted greetbot-like exchange
  (onboarding → language pick with inline buttons → an in-place edit → a
  follow-up message) through a real `Session` + `IframeHost` + `FakeBot`
  and validates `toBundle()`'s output against that schema with
  [ajv](https://ajv.js.org)'s 2020-12 dialect. Ajv runs with `strict:
  false` and a small hand-rolled `date-time` format checker instead of the
  `ajv-formats` package, since this task keeps new devDependencies to
  `vitest` and `ajv` only; every other schema keyword (`type`, `required`,
  `enum`, `additionalProperties`, …) is still fully enforced.

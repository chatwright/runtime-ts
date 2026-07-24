# `runtime-ts` architecture — first slice

**Status:** iframe transport + Telegram codec (text, inline buttons, edits) +
WhatsApp codec (text only — no buttons, no edits) + the deterministic expect
layer (`src/expect/`). Everything below describes what is actually
implemented in `src/` today, not an aspiration — see
[README.md](../README.md#fidelity) for the fidelity list and
[`docs/runtime-parity.md`](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md)
(decision 0015) for how this slice compares to `runtime-go`.

## Session model

[`Session`](../src/session/session.ts) is the orchestrator this slice ships.
One `Session` instance:

- Registers **exactly one bot** via `registerBot(transport)`, where
  `transport` is anything implementing [`BotTransport`](../src/transport/transport.ts)
  — in practice, an [`IframeHost`](../src/protocol/iframe-host.ts).
- Turns `submitText(chatId, user, text)` / `submitClick(chatId, user,
  actionId, targetMessageId)` calls into platform-native updates, delivered
  to the bot via the transport.
- Answers the bot's calls by handing them to its configured [`PlatformCodec`](../src/platform/codec.ts)
  and relaying the result back through the transport.
- Owns one [`InMemoryJournal`](../src/journal/in-memory-journal.ts) per chat
  id, lazily created the first time that chat is addressed.
- Assembles everything recorded so far into a run-bundle v1 document via
  `toBundle()`: one run, an actor roster (a human actor and a bot actor,
  each with a platform identity — keyed by the codec's `platform` — once one
  has been observed), one chat entry per addressed chat, and **one
  deterministic part whose journal boundary spans the entire recording** —
  this slice does not yet split a run into multiple parts or attach an
  AI-goal part.

**Codec-agnostic by construction, not by coincidence.** `Session` is
generic over `SessionOptions.codec: PlatformCodec` (default: a
[`TelegramCodec`](../src/telegram/codec.ts) built with the session's own
`clock`) — it never imports a platform name as a string literal, never
branches on which codec it holds, and gets `platform`, every
`platformIdentities` key, and the bot actor's wire identity entirely from
`codec.platform`/`codec.botIdentity`. This is what let
[`WhatsAppCodec`](../src/whatsapp/codec.ts) — the runtime's second codec —
plug in as `new Session({ codec: new WhatsAppCodec(clock) })` with **no
change to `Session`'s control flow**, only additive typing (`PlatformUser`
replacing the Telegram-specific `TelegramUser` on `submitText`/
`submitClick`'s parameters, and an honest thrown error from `submitClick`
when the configured codec omits `buildCallbackUpdate` — see "The platform
codec seam" below). See the [`PlatformCodec`](../src/platform/codec.ts)
seam's doc comment for the full interface this generality rests on.

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
  removes the existing keyboard when `reply_markup` is omitted, like real
  Telegram: a keyboard only survives an edit if the call explicitly
  re-sends `reply_markup`), `answerCallbackQuery` (acknowledged, no journal
  entry — it produces no observable chat content), and `getMe`.
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

### 2b. Platform codec seam, second implementation — `WhatsAppCodec`

[`src/whatsapp/codec.ts`](../src/whatsapp/codec.ts) is the runtime's second
[`PlatformCodec`](../src/platform/codec.ts), builds and parses WhatsApp
Cloud (Graph) API payloads, porting `runtime-go`'s
[`whatsapp.Emulator`](https://github.com/chatwright/runtime-go/blob/main/whatsapp/emulator.go)
as an algorithm — same rule as `TelegramCodec`, and proof that the
`PlatformCodec` seam `TelegramCodec` first proved out generalises to a
second platform without touching `Session`'s control flow (see "Session
model" above):

- `buildTextUpdate` builds a `messages` webhook update for a user's
  submitted text and journals the inbound entry, mirroring
  `Emulator.SubmitText` — including its identity scheme: message ids come
  from a **per-chat** sequence shared by inbound and outbound messages
  (like Telegram's), but WhatsApp has no separate "update id" concept at
  all (a webhook body carries no top-level sequence number), so unlike
  `TelegramCodec` there is no second, codec-wide sequence here. `chatId`
  doubles as the sender's `wa_id` on the wire — WhatsApp has no
  chat-identity/user-identity split the way Telegram incidentally has one
  — so `user.id` is never read, only `user.firstName` (the contact profile
  name), exactly mirroring `Emulator.SubmitText`.
- `handleCall` parses and answers exactly one call shape: `method ===
  "sendMessage"` with `params.type === "text"` — mirroring the `wabotapi`
  Go client's own `Client.SendMessage`/`SendTextConfig` JSON body. It
  journals a bot message entry (`version` always `0` — the Cloud API has no
  edit endpoint, so unlike Telegram's journal there is no version concept
  here at all) and returns the Cloud API's success envelope, down to the
  literal `"wamid.reply"` id `Emulator.handle` itself always returns.
- Every other call — a `type` other than `"text"`, or a `method` other than
  `"sendMessage"` — returns the Cloud API's own `{"error": {"message",
  "type", "code", "error_subcode", "fbtrace_id"}}` shape (`type:
  "ChatwrightNotEmulated"`, `code: 501` — chatwright's own honesty marker,
  borrowing the same not-a-real-platform-code convention `TelegramCodec`'s
  `501` already established, never a value the real Cloud API would send)
  and journals an `"uncaptured"` entry.

**No interactive actions — `buildCallbackUpdate` is omitted entirely, not
stubbed.** `runtime-go`'s `Emulator` does implement `SubmitClick` (an
inbound interactive-reply click), but this slice's declared `capabilities`
— `["messaging.text"]` — carries no interactive-action support, so this
codec simply does not define `buildCallbackUpdate` (the `PlatformCodec`
seam makes it optional for exactly this reason — see its own doc comment).
`Session.submitClick` checks for its presence and throws a clear,
platform-named error for any codec that omits it, rather than the call
silently doing nothing. This is a deliberate parity gap versus
`runtime-go`, recorded in the fidelity list in
[README.md](../README.md#fidelity) and the cross-repo parity register —
never silently absorbed.

**One recorded strengthening versus `runtime-go`, not a narrowing.**
`Emulator.handle` (the Go emulator's HTTP handler) blindly decodes *any*
POST to a `/messages`-suffixed path as `wabotapi.SendTextConfig` and always
succeeds — its own doc comment names this directly as a known MVP-scope
gap ("this text-first MVP-scope emulator does not yet capture outbound
interactive actions … `JournalEntryUncaptured` never occurs"). This codec
instead inspects the call's `type` field — the same discriminator the real
Cloud API itself switches on — and honestly reports anything other than
`"text"` as unsupported (error envelope plus an `"uncaptured"` entry)
rather than silently losing the call's content. See `src/whatsapp/codec.ts`'s
module doc comment for the full reasoning; this is the one place this
codec is *stricter* than `runtime-go`, not narrower, and is recorded the
same way any other deviation is (decision 0008).

**Journalled `fromId` is always `0`.** `runtime-go`'s own `toPlatformEntry`
never sets `platform.JournalEntry.FromID` for a WhatsApp entry, inbound or
outbound — mirrored here faithfully (bug-for-bug, not "fixed"
unilaterally) rather than diverging from Go's actual semantics, per
principle 7's identical-semantics rule. Worth a `runtime-go` follow-up, out
of scope for this slice.

The codec does not own journal storage itself, for the same reason
`TelegramCodec` doesn't — see above.

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

## The expect layer — deterministic scenario verbs

[`src/expect/`](../src/expect/) is a fourth piece layered on top of
`Session`, not one of decision 0012's three seams itself: the deterministic
scenario-verb API a test author actually writes against —
`chatOf(session, chatId, user)` returning a `Chat` handle
(`sendText`/`click`/`expectBotMessage`/`expectEdited`), each
`expectBotMessage`/`expectEdited` call resolving to a `BotMessageExpectation`
(`text`/`expectText`/`expectActions`/`within`). It is the TypeScript twin of
`runtime-go`'s `cw` package
([`cw/chat.go`](https://github.com/chatwright/runtime-go/blob/main/cw/chat.go),
[`cw/expect.go`](https://github.com/chatwright/runtime-go/blob/main/cw/expect.go)),
ported as an algorithm — never shared as code, per decision 0012 — and is
this repository's answer to the founder's canonical scenario named in
research item I-71: "expect a bot message with exactly buttons [Yes, No];
user clicks [Yes]", which is exactly `src/expect/chat.test.ts`'s first test.

### Design

- **Built entirely on `Session.journal(chatId)`.** `expect/` never talks to
  the transport, the codec or `IframeHost` directly — `Chat.sendText`/
  `click` call `session.submitText`/`submitClick`, and
  `expectBotMessage`/`expectEdited` read and subscribe to the `Journal`
  `session.journal(chatId)` already returns. This keeps the expect layer a
  pure consumer of the same public seam any other caller has.
- **Subscribe-based waiting, never polling** ([`src/expect/wait.ts`](../src/expect/wait.ts)).
  `waitForCondition(journal, compute, timeoutMs, onTimeout)` is the async
  twin of `runtime-go`'s `Emulator.WaitForMessage`/`WaitForEdit`: check
  `compute()` once immediately (the result may already be in the journal),
  otherwise subscribe and re-run `compute()` — a pure function of the whole
  journal, matching Go's re-scan-on-every-wake shape exactly — after every
  subsequent append, racing a `setTimeout(timeoutMs)` deadline. The only
  timer anywhere in this layer is that one deadline; there is no interval,
  no re-check loop.
- **The consumption cursor, ported exactly.** `Chat` tracks `consumed`
  (bot messages already handed out) precisely like Go's `cw.Chat`:
  `expectBotMessage` calls `nthOutboundMessage(entries, consumed)` — a
  direct port of `nthOutboundMessageLocked` — which finds the
  `(consumed + 1)`-th distinct bot message id in first-seen order and
  returns its *current* (possibly already-edited) content, then increments
  `consumed` only once that wait actually resolves (never on a timeout).
  `expectEdited(ref)` instead calls `latestEntryForMessage` for `ref`'s
  specific `messageId` and waits for a `version` strictly greater than
  `ref.version` — and, matching Go precisely, never touches `consumed` at
  all.
- **Transcript-in-failure, ported as an algorithm.**
  [`src/expect/transcript.ts`](../src/expect/transcript.ts)'s
  `renderTranscript` is a direct algorithmic port of
  `Emulator.Transcript`/`renderTranscript` in `runtime-go`'s
  `telegram/emulator.go`: chronological, one line per message, an edit
  rewriting its message's existing line in place (never appending a new
  one) so a message keeps its conversational position. Every `Error` this
  layer throws or rejects with embeds the chat's transcript at the moment
  of failure, mirroring Go's `t.Fatalf(...emu.Transcript(chatID))`
  convention — a failure is self-contained, never "none arrived" with no
  further context.
- **`chatOf` aliases by `(session, chatId)`**, exactly like Go's
  `Chatwright.PrivateChat` aliases by user identity: calling `chatOf` again
  for a chat already addressed returns the same `Chat` — same cursor, same
  latency baseline — rather than a fresh one that would silently reset both.

### Deliberate deviations from `runtime-go`

Recorded here, not just in code comments, per decision 0008 ("fidelity is
declared, never assumed") — also reflected in the fidelity table in
[README.md](../README.md#fidelity) and the cross-repo
[runtime parity register](https://github.com/chatwright/chatwright/blob/main/docs/runtime-parity.md):

- **`within(ms)` asserts; it does not extend the wait.** Go's `BotMessage`
  is returned by `ExpectBotMessage()` *before* it resolves — it is a lazy
  handle whose `resolve()` only runs the first time an assertion method is
  called on it — so `Within(d)` can be called on that not-yet-resolved
  handle and, if `d` exceeds the configured safety timeout, extend how long
  the wait itself runs before falling back to a bare timeout. This
  runtime's `expectBotMessage`/`expectEdited` are `async` functions that
  only ever hand back a `BotMessageExpectation` *after* the message has
  actually arrived (there is no useful "not yet resolved" JavaScript object
  to return synchronously from an inherently asynchronous wait), so there is
  nothing left unresolved to attach a budget to beforehand. `within(ms)` is
  therefore a pure post-arrival assertion against the latency already
  recorded when the promise settled; a caller who wants a generous
  observation window passes a larger `timeoutMs` to `expectBotMessage`/
  `expectEdited` directly instead. One consequence: Go's "`Within` called
  after resolution is a usage error" guard has no equivalent — it is
  structurally impossible to call `within()` before arrival here, since the
  object it lives on doesn't exist until arrival.
- **Latency is measured in real wall-clock time** (`Date.now()`) inside
  `Chat`, independent of whatever `Session` was constructed with as its
  `Clock` for journal-entry/bundle timestamps. `runtime-go` has no
  injectable clock at all (the emulator always calls `time.Now()`), so real
  wall-clock time is the closest equivalent; it also means latency
  assertions behave sensibly even against a `Session` built with a
  fixed/tick `Clock` for bundle-determinism (as `session.test.ts` does),
  where journal-entry timestamps alone would be meaningless for measuring
  elapsed real time.
- **`click(actionIdOrLabel)` targets the chat's most recently resolved
  message**, not an explicit `(row, col)` coordinate the way Go's
  `BotMessage.ExpectAction(row, col).Click()` does. `Chat` remembers the
  `messageId` and action rows from whichever of `expectBotMessage`/
  `expectEdited` resolved most recently and searches its rows for an action
  whose id (Telegram `callback_data`) or label matches `actionIdOrLabel`.
  This matches a Playground chat's actual UI model — a user can only click
  a button on the bubble currently on screen — more directly than plumbing
  coordinates through, at the cost of not supporting "click a button on an
  older, already-superseded message" (not a real scenario need; Go's
  coordinate API supports it only as a side effect of its own design).
- **Naming: `expect`-prefixed assertions, and `text()` as a separate
  getter.** `expectText`/`expectActions`/`expectEdited` versus Go's bare
  `Text`/`ExpectAction`, and `text()` (no assertion, just returns the
  current text) kept distinct from the `expectText(want)` assertion. Purely
  cosmetic — no semantic difference from Go.

### Testing

[`src/expect/chat.test.ts`](../src/expect/chat.test.ts) follows the same
DOM-free pattern as `session.test.ts` — a real `Session` + `IframeHost` +
`FakeBot` over a Node `MessageChannel`, the test script itself playing the
bot's role by issuing `bot.call(...)` calls — proving:

1. **The founder's canonical case** (I-71): `expectBotMessage()` resolves to
   a message with exactly `["Yes", "No"]` buttons; `click("Yes")` sends the
   callback; `expectEdited(ref)` resolves to the in-place edit.
2. A timed-out `expectBotMessage()` rejects with an `Error` whose message
   names the safety timeout and embeds the chat's transcript.
3. `within(ms)` throws, after a successful (late) arrival, when the
   recorded latency exceeds the budget — and does not throw for a generous
   budget.
4. The consumption cursor across multiple messages: three `sendMessage`
   calls resolve to three `expectBotMessage()` calls in order, one message
   each, with a fourth call correctly timing out with nothing left
   unconsumed.
5. `chatOf` aliasing: repeated calls for the same `(session, chatId)` return
   the identical `Chat` handle.

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
- **I-71** (portable scenario format): `src/expect/` lands the deterministic
  verb *API* — scenarios are still written directly in TypeScript against
  `Chat`/`BotMessageExpectation`, not against a declarative, runtime-neutral
  file format that both `runtime-go` and `runtime-ts` could execute
  identically. An `ExpectNoMessage`-equivalent (assert *no* reply arrives
  within a window) is also not implemented in this slice.

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
- [`src/expect/chat.test.ts`](../src/expect/chat.test.ts) covers the
  deterministic expect layer over the same `Session` + `IframeHost` +
  `FakeBot` DOM-free setup — see "Testing" under "The expect layer" above
  for exactly what it proves.
- [`src/whatsapp/codec.test.ts`](../src/whatsapp/codec.test.ts) is
  `WhatsAppCodec`'s pure-unit twin of `src/telegram/codec.test.ts`: the
  `buildTextUpdate` webhook shape and per-chat message-id sequence, a
  successful `sendMessage`/`type:"text"` round trip, the honest error +
  `"uncaptured"` journal entry for a non-text `type` and for an unrecognised
  `method`, and that `buildCallbackUpdate` is genuinely absent from the
  codec (not merely unused).
- [`src/session/session.whatsapp.test.ts`](../src/session/session.whatsapp.test.ts)
  is the WhatsApp twin of `session.test.ts`'s scripted exchange, kept in its
  own file rather than merged into `session.test.ts` so each platform's
  scenario stays independently readable: the iframe handshake completing
  with `platform: "whatsapp"`, a plain-text round trip end to end, the
  honest error path for an unsupported call, `submitClick` throwing because
  this codec omits `buildCallbackUpdate`, and a full numbered-replies
  conversation ("Choose your language: 1) English 2) Español 3) Français" →
  user replies `"1"` → bot greets — plain text throughout, no buttons)
  whose `toBundle()` output validates against the same vendored run-bundle
  v1 schema with `platform: "whatsapp"` and a `whatsapp`-keyed
  `platformIdentities` entry.

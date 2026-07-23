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

## Status: scaffold

This repository is **interfaces and protocol types only**. There is no
working emulator, no transport implementation, no runtime orchestration —
deliberately. Deep design happens in dedicated sessions tracked as research
backlog items in
[`chatwright/chatwright`](https://github.com/chatwright/chatwright)'s
[`spec/research/knowledge-platform.md`](https://github.com/chatwright/chatwright/blob/main/spec/research/knowledge-platform.md):

- **I-66** — browser runtime internals: how `runtime-ts` structures
  orchestration (scenario execution, bot registry, routing, correlation,
  state) and how the player's rendering accepts a live, append-only journal.
- **I-67** — platform emulation fidelity in TypeScript: which Bot API slice
  the browser Telegram emulator covers first, and how parity with the Go
  emulator is proven.
- **I-68** — the bot protocol envelope's full specification: error
  semantics, timeouts, port lifecycle, multi-chat routing, version
  negotiation, iframe `sandbox`/CSP attributes.

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
  (`{id, kind, platform, payload}`) carrying platform-native JSON. See
  [`src/protocol/envelope.ts`](src/protocol/envelope.ts).
- **Remote HTTPS** — the runtime exposes an emulated platform API base URL;
  the bot swaps its API root, registers a webhook or long-polls, and calls
  platform methods against the emulated server — exactly today's Go-runtime
  pattern, promoted to a public contract.

Full rationale lives in decision
[0012](https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md)
("Black-box bots over platform-native payloads; a browser runtime").

## Package layout

```
src/
  protocol/envelope.ts   the iframe postMessage envelope + PROTOCOL_VERSION
  transport/transport.ts BotTransport interface; IframeTransport/HttpTransport stubs
  platform/codec.ts       PlatformCodec interface (per-platform, Telegram first)
  journal/journal.ts      append-only Journal + JournalEntry, mirrors platform.JournalEntry
  runtime/runtime.ts       ChatwrightRuntime orchestrator interface
  index.ts                re-exports
```

These are the three seams decision 0012 decomposes the Go emulator's
monolith into — platform codec, transport, journal + observation — plus the
envelope that ties transports together and the runtime that ties the seams
together.

## Shared contracts are formats, never code

Chatwright's cross-language contracts are language-independent formats:

- The [run-bundle v1 schema](https://github.com/chatwright/chatwright/blob/main/formats/run-bundle/v1/schema.json)
  — the wire contract this runtime eventually produces. `runtime-ts` becomes
  its second producer, byte-compatible with the Go runtime's output. This
  scaffold does not generate types from that schema yet; it only references
  it (see [`src/journal/journal.ts`](src/journal/journal.ts)).
- The bot-protocol envelope (this repository's `src/protocol/envelope.ts`,
  eventually promoted to a JSON Schema under `formats/` per I-68).
- `CHATWRIGHT.md` — the repository manifest format (decision
  [0013](https://github.com/chatwright/chatwright/blob/main/spec/decisions/0013-chatwright-md-federation.md)).

Conformance between the Go and TypeScript runtimes is proven by shared
fixtures, never by shared libraries.

## Development

No dependencies are installed for this scaffold. Typecheck with the
TypeScript compiler declared in `devDependencies`:

```sh
npm install
npm run typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE).

Chatwright is an independent open-source project developed by
[Sneat.co](https://sneat.co).

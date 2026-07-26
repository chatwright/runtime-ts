# Runtime parity: `runtime-ts` ↔ `runtime-go`

Per AGENTS.md principle 7, the TypeScript and Go runtimes carry **identical
semantics**. This document records the deliberate browser/TypeScript
deviations from the Go reference (`chatwright.dev/runtime`) in the AI
actor-model engine foundation — the observe, goal, actor and actor/openai
modules — so a reader can trust that everything not listed here is a
faithful, behaviour-for-behaviour port.

## Modules ported

| TS module | Go source |
| --- | --- |
| `src/observe/` | `observe/engine.go`, `observe.go`, `validate.go` + `actor/loop.go`'s `observedEffect`/`semanticallyEqualMessage` |
| `src/goal/` | `goal/goal.go`, `budgets.go`, `campaign.go`, `status.go`, `content_rules.go`, `errors.go` |
| `src/actor/provider.ts`, `loop-event.ts`, `scripted-provider.ts` | `actor/provider.go`, `loop_event.go`, `scripted_provider.go` |
| `src/actor/openai/` | `actor/openai/provider.go`, `prompt.go`, `response.go`, `wire.go`, `errors.go` |

## Deviations (each intentional, none semantic)

1. **Errors are thrown, not returned.** Go returns `(value, error)` tuples; the
   TypeScript port throws. Guard/validation failures in `goal` throw a single
   `GoalError` carrying a stable string-literal `code` (the browser-idiomatic
   twin of Go's sentinel + `errors.Is`); `actor/openai` throws its typed error
   classes (`AuthenticationError`, `RateLimitError`, `InvalidResponseError`,
   `FallbackFailedError`). The verdict/stop-reason/kind **string values are
   identical** across runtimes.

2. **`Usage` alongside a rejected proposal.** Go's `openai.Propose` returns
   `(Proposal{}, usage, err)` — usage survives even when the proposal is
   rejected. A thrown error cannot return a second value, so the successful
   call's `Usage` is attached to `InvalidResponseError.usage` instead. No
   information is lost.

3. **Time is `number` milliseconds, not `time.Time`/`time.Duration`.** Injected
   clocks (`now: () => number`) return epoch **milliseconds**; durations
   (`Budgets.maxDurationMs`, `Usage.latencyMs`, `CampaignSnapshot.elapsedMs`)
   are milliseconds, where Go used `time.Duration` nanoseconds. The clock is
   injected everywhere — no engine code calls `Date.now()` directly (only the
   `openai` provider's *default* clock falls back to `Date.now`, exactly as Go
   defaults to `time.Now`).

4. **Injected `fetch` replaces `*http.Client`.** The OpenAI provider POSTs
   through a `FetchLike` supplied on `Config.fetch` (defaulting to the global
   `fetch`), so tests drive it with zero network — the analogue of the Go
   tests' `httptest.Server`.

5. **`%q` prompt formatting → `JSON.stringify`.** The user-prompt renderer uses
   `JSON.stringify` where Go used `fmt`'s `%q` verb. The two produce
   byte-identical output for the ASCII text this renderer handles; the rendered
   system + user prompts are snapshot-tested and match the Go layout exactly.

6. **No mutexes.** Go's `observe.Engine`, `goal.CampaignState` and
   `openai.Provider` use `sync.Mutex`; the single-threaded JavaScript runtime
   needs none, so the locks are simply dropped. Observable behaviour is
   unchanged.

7. **`context.Context` dropped.** Go's `ProviderFunc`, `Criteria` and
   `ContentPredicate` take a `context.Context`; the browser port omits it.
   `TaskCriteria` may return a `Promise<boolean>` for async evaluation.

## Journal-entry field mapping (no gap)

The observe projection consumes **this repo's** `src/journal/journal.ts`
`JournalEntry`, not Go's `platform.JournalEntry`. The shapes are field-for-field
equivalent, so the projection maps cleanly with **no missing load-bearing
field**:

| observe needs | `runtime-ts` `JournalEntry` field |
| --- | --- |
| logical message identity | `messageId` |
| per-message version | `version` |
| author / direction | `direction` (`"bot"`/`"user"`) |
| message text | `text` |
| action row/col grid | `actions?: JournalAction[][]` (rows of `{ label, id, url }`) |
| entry kind filter | `kind` (`"message"` only projects) |

`AvailableAction.id` is minted in exactly the Go form
`act-<msgID>-<version>-r<row>c<col>`; `actions` being optional
(`undefined` when an entry carries no keyboard) is handled as an empty grid.

## Not ported here (follow-up slice, by design)

The actor **loop** (observe-plan-act-validate), scenario/run wiring and
run-bundle emission are out of scope for this foundation. The interfaces they
will consume are exported cleanly: `Provider`/`Prompt`/`Proposal`/`Usage`,
`LoopEvent`/`ValidationOutcome`/`ActionOutcome`, `ObserveEngine`,
`CampaignState`, and `observedBotEffect`/`semanticallyEqualMessage`.

---

## Part 2 — actor loop, deterministic evaluator, scenario/run, bundle

The follow-up slice (`src/actor/loop.ts`, `src/deterministic/`, `src/run/`,
`src/scenario/`) is ported from Go's `actor/loop.go`, `campaign/report.go` +
`assemble.go`, `run/*.go`, `arena/scenario.go` and `cw/expect.go`. Additional
deliberate deviations, on top of the foundation ones above:

1. **`Actuator` seam over `Session`, synchronous delivery.** Go's `Actuator` is
   a subset of `platform.Emulator`; the TS `Actuator` is implemented by
   `SessionActuator` over this repo's `Session`. Its `submitText`/`submitClick`
   are synchronous and assume the bot-under-test reacts before control returns
   (mirroring Go's synchronous webhook delivery), so the journal is settled by
   the time the loop re-observes. `waitForMessage`/`waitForEdit` still go
   through the shared subscribe-driven `waitForCondition` — **never a poll** —
   returning `undefined` on timeout (the twin of Go's `(*Message, false)`).

2. **Campaign-stopped guard.** Go ignores `errors.Is(err, ErrCampaignStopped)`
   after `recordStep`/`recordCost`/`recordFailure`/`abort`; the TS loop wraps
   those in a helper that swallows exactly a `GoalError` with
   `code === "campaign-stopped"` and rethrows anything else.

3. **`LoopEvent` fields relaxed to optional.** A propose-error event carries no
   `proposal`/`usage`/`validation`/`action` (Go's zero values); the bundle wire
   emits the schema's required zero-value objects (`kind: ""`, etc.) for them.

4. **Deterministic testing is a NEW data-driven, serialisable model.** Go's
   deterministic side is a fluent code DSL (`cw/expect.go`); `src/deterministic`
   preserves its **semantics** (`text-equals`/`text-contains`/`text-matches`/
   `expects-action`/`edited`/`within`) as plain serialisable assertion objects,
   targeting a bot message by 1-based `botTurn` ordinal. Each yields
   `pass | fail | unverified` with a diagnostic. Side-effect (`data-state`/DTQL)
   assertions evaluate to `unverified` with a browser-limitation reason unless a
   pluggable `SideEffectVerifier` (the companion-server seam) resolves them.

5. **`Run` is scoped to steps + evaluator, not the full Go composition
   subsystem.** A deterministic `Part` performs `steps` then runs the evaluator;
   it does **not** port Go's `cw.Fragment`/`InvokeFragment`/`ExecutionContext`
   provenance machinery, nor `FailurePolicy`, `RunCeiling`, or the
   `coverage-gap`/`ceiling-stopped`/`aborted` part statuses (out of this
   slice's scope). The `RunEnvironment` is a `Session` (this runtime's emulator
   equivalent); journal boundaries are computed by snapshotting session journals
   before/after each part. A Studio UI subscribes to live updates via
   `ExecuteOptions.onProgress` (part boundaries + forwarded loop
   `ProgressSnapshot`s) and `onAssertion` (per-assertion outcomes).

6. **Bundle wire conversions.** `buildRunBundle` reuses `Session.toBundle()` for
   the base and replaces its single part with the run's parts, filling the
   reserved `aiGoal` section. Durations become nanoseconds
   (`maxDurationNanoseconds`, `elapsedNanoseconds`, `latencyNanoseconds`);
   `LoopEvent.at` (ms) becomes an ISO date-time string; empty action grids are
   emitted as `null` to match Go's nil. Provider/model provenance is attached to
   the matching roster actor. The emitted bundle is validated against
   `run-bundle/v1/schema.json` with `ajv` in the greetbot e2e test.

7. **greetbot provider is an observation-driven policy provider, not a fixed
   `ScriptedProvider`.** The click step targets an opaque
   `AvailableAction.id` only known once the picker is observed, so — exactly as
   Go's own `ScriptedProvider` doc advises for opaque ids — the greetbot
   scenario uses a thin observation-reading policy provider. `ScriptedProvider`
   itself is used directly in the loop unit tests (happy path, non-progress
   abort, stale-click rejection, premature-done rejection), all zero-network.

8. **greetbot bot-under-test is a synchronous in-process `BotTransport`.**
   `src/testkit/greetbot-bot.ts` is a reactive fake (the same seam
   `Session.registerBot` consumes), distinct from the iframe `FakeBot` in
   `fake-bot.ts` (which drives the postMessage handshake). Zero network. Its
   behaviour is a faithful port of Go's `examples/greetbot`.

9. **Scenario documents are invocation-manifest-first.** `parseScenarioManifest`
   validates structure only — no bot start, DB access or secret expansion — and
   rejects an unsupported schema version or capability **explicitly**, retaining
   the original document (feature AC `unsupported-schema-is-safe`).

### Greetbot verdict parity

The greetbot e2e drives the loop to `goal-complete` with the single task
`completed`, the journal re-check `verified: true` ("started, clicked English,
acknowledged — all journal-verified"), and all four data-driven assertions
`pass` — the same verdict Go's `arena` greetbot scenario produces (task
complete + `verifyGreetbotJournal` verified), proven here entirely in-process
against a fake bot with zero network.

---

## Part 3 — self-contained scenario documents (`scenario-document/v1`)

Ported from `runtime-go`'s `scenario/` package (`chatwright.dev/runtime`
v0.4.0): `document.ts` (shape), `issues.ts` (`Issue`/`Report`, from
`scenario/report.go`), `document-parse.ts` (from `scenario/parse.go`),
`document-shape.ts` (forbidden/unknown-member scans), `document-secrets.ts`
(from `scenario/secrets.go`), `document-fidelity.ts` (from
`scenario/fidelity.go`), `document-validate.ts` (from `scenario/validate.go`),
`document-verify.ts` (from `scenario/verify.go`), `document-build.ts` (in
*spirit* from `scenario/build.go`, deliberately narrower in *scope* — see
below), and `examplebots.ts` (from `scenario/examplebots.go`). Conformance
evidence: `document-parse.test.ts` (36 cases ported from `validate_test.go` +
`parse_security_test.go`), `document-verify.test.ts` (byte-parity cases
ported from `verify_test.go`), `document-conformance.test.ts` (parses,
builds and executes `testdata/greetbot-language-onboarding.json` — a
byte-identical copy of `runtime-go`'s own fixture, diffed at copy time).

### Deviations (each intentional, declared)

1. **Scenario-document bot transport support remains the mirror image of
   `runtime-go`'s, while the low-level HTTP transport now has a webhook
   delivery slice.**
   `runtime-go` accepts `transport: "http"` and refuses `"iframe"` by name
   (no iframe host). `runtime-ts` accepts `"iframe"` (✅ Works — `IframeHost`)
   and refuses `"http"` by name for scenario-document Build because it still
   has no emulated platform API listener in a browser page. The low-level
   `HttpTransport` does implement outbound webhook delivery and Telegram
   JSON/form inline-response method processing; that does not yet satisfy a
   URL-addressed scenario's complete API-root contract. Both refusals use the same
   issue code, `unsupported-transport`, and name the transport explicitly —
   the format's `unsupported-transport-is-refused-by-name` acceptance
   criterion is satisfied by each runtime refusing the OTHER runtime's
   supported transport, never by approximating either one.

2. **No unknown-field decoder, so `document-shape.ts` hand-writes one.** Go's
   `encoding/json` `DisallowUnknownFields` rejects an unrecognised member for
   free (stopping at the first one found); TypeScript has no stdlib
   equivalent, so `checkUnknownMembers` is a hand-written, shape-aware walk
   mirroring `Document`'s own member set at every nesting level, and reports
   EVERY unknown member found rather than only the first. Both behaviours
   reject the same documents — the only difference is how many issues a
   multi-violation document reports, which no acceptance criterion pins.

3. **Cassette playback is not implemented — model-free parity, declared, not
   half-built.** `runtime-ts` has no cassette engine at all (Go's key is
   `sha256(providerConfig + "\x00" + json.Marshal(prompt))` — Go struct field
   order — which this runtime cannot reproduce without inventing its own
   canonical-JSON keying contract; see AGENTS.md principle 4 and the
   feature's own "Open Questions"). `document-build.ts` satisfies a
   `cassette`+`replay` provider on the `exampleBot: "greetbot"` fixture ONLY,
   by substituting the repository's own hand-authored, deterministic
   `GreetbotProvider` policy (`greetbot.ts`) — it drives the same happy path
   a recorded cassette would replay, at zero network/token cost, but it is a
   fixture-specific substitution, not a general engine. The substitution is
   always recorded in `BuiltScenario.providerOverrides` (the format's own
   "a runner overriding a declared provider MUST record the override" rule).
   A `cassette` provider on any other bot, and every `model`-kind provider,
   is refused by name (`ScenarioBuildError`) rather than silently attempted.
   **Parity therefore rests on the resolved run description plus the
   verdict, not on a shared cassette file** — the "Open Questions" section's
   own stated fallback.

4. **`url`-addressed bots (`http`/`iframe`) validate but do not Build.**
   `document-validate.ts` accepts a well-formed `iframe` document (see
   deviation 1); `document-build.ts` does not yet wire a live `IframeHost`
   from a parsed document — that is follow-up work this task did not
   attempt. Build refuses by name (`ScenarioBuildError`, tested in
   `document-conformance.test.ts`) rather than silently producing a `Run`
   that cannot reach the bot. Only `bot.exampleBot === "greetbot"` is wired.

5. **`failurePolicy` and `ceiling` are accepted and validated, never
   enforced at execution time.** This is a PRE-EXISTING gap, not one this
   slice introduces: `runtime-ts`'s own `run` package does not implement
   `FailurePolicy`/`RunCeiling` semantics at all (see "Part 2" item 5,
   above) — every part in `executeRun` runs to completion regardless of a
   sibling part's failure or an aggregate ceiling. `document-validate.ts`
   still enforces the DOCUMENT-level shape rules identically to `runtime-go`
   (budgets non-negative, `maxCost` positive-if-set, `no-run-ceiling`
   reported when absent), so a document that *declares* an invalid
   `ceiling`/`failurePolicy` is still rejected/warned identically in both
   runtimes — only the RUN-TIME enforcement (the
   `ceiling-trip-attributes-run-and-part` acceptance criterion) is unmet
   here. Tracked as parity debt, not silently dropped.

6. **The bot roster's `platformIdentity.firstName` does not carry
   `bot.name`.** `runtime-go`'s `botRosterActor` copies `Bot.Name` into the
   emulated identity's `FirstName` (`{UserID: telegram.EmulatedBotUserID,
   FirstName: b.Name}`). `runtime-ts`'s `Session` assigns the bot's platform
   identity entirely from its `TelegramCodec` (`{userId: 1, firstName:
   "ChatwrightBot"}`, a fixed constant — `src/telegram/codec.ts`'s
   `TELEGRAM_BOT_USER_ID`/`TELEGRAM_BOT_FIRST_NAME`), independent of the
   `SessionActor.name` a caller passes to `Session`'s constructor. This is a
   PRE-EXISTING property of `Session`/`TelegramCodec` (present before this
   slice, and already true of the hand-authored greetbot e2e test), not
   something `document-build.ts` introduces or attempts to fix here — fixing
   it would mean letting a session's bot platform identity be
   caller-overridden, a `Session`-wide design change out of this task's
   scope. Recorded here rather than silently claimed as parity: the "same
   bot roster identity" half of `greetbot-scenario-is-expressible` is a
   Go-only acceptance criterion (compared against `arena.GreetbotScenario()`
   there); the cross-runtime `same-document-same-verdict-in-both-runtimes`
   criterion is satisfied at the DOCUMENT's own resolved fields (`bot.id`,
   `bot.name`, `cast[*].platformIdentity`), which this module reproduces
   byte-for-byte from the shared fixture in both runtimes — not at the
   `Session`-internal, `TelegramCodec`-assigned wire identity.

7. **Live model providers (`kind: "model"`) are not wired.** `runtime-ts`
   already has an OpenAI-compatible provider (`src/actor/openai/`), but
   wiring `apiKey` secret resolution honestly (a browser page has no
   `process.env`; `document-secrets.ts`'s `EnvOnlySecretResolver` only
   suits a Node-hosted caller such as a CLI or this repository's own test
   suite) is real, untested work this task did not attempt. `resolveSecret`/
   `SecretResolver`/`EnvOnlySecretResolver` are exported ready for a
   follow-up slice to wire; `document-build.ts` refuses `kind: "model"` by
   name in the meantime.

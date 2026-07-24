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

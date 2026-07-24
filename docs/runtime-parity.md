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

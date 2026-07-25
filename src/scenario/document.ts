/**
 * The self-contained scenario document format
 * (`https://chatwright.dev/formats/scenario-document/v1`) — the TypeScript
 * embodiment of the shape
 * `chatwright/chatwright`'s
 * `spec/features/chatwright/scenario-authoring/portable-scenario-documents/
 * self-contained-scenario-documents/README.md` defines, ported field-for-field
 * from `runtime-go`'s `scenario/document.go` (the reference implementation,
 * `chatwright.dev/runtime` v0.4.0).
 *
 * @remarks
 * One committed, language-neutral document declares a bot endpoint, an AI
 * goal with its tasks and budgets, the cast, the declared fidelity and an
 * independent journal verification — everything a hand-registered scenario
 * carries compiled into code, expressed instead as one JSON file both
 * Chatwright runtimes execute to the same verdict with no Go or TypeScript
 * written. This module is types and string-constant vocabulary only; see
 * `document-parse.ts` for the pure parser, `document-validate.ts` for the
 * structural rule engine, `document-verify.ts` for the independent journal
 * re-check and `document-build.ts` for the (deliberately narrow) mapping onto
 * an executable {@link "../run/run.js".Run}.
 *
 * Object keys are camelCase with `Id`/`Url` acronym casing, matching the
 * format's own wire vocabulary and this package's own JSON-artefact
 * convention: string constants only, never integer enums.
 */

/** The scenario-document format identifier this module parses. */
export const SCENARIO_DOCUMENT_FORMAT = "https://chatwright.dev/formats/scenario-document/v1";

/** The only `schemaVersion` this module accepts. */
export const SCENARIO_DOCUMENT_SCHEMA_VERSION = 1;

/** {@link Fidelity.endpointProfile} — decision 0008's vocabulary. */
export type EndpointProfile = "platform-emulated" | "headless-engine";

/** {@link Fidelity.environment} — the sensitive-data-redaction idea's vocabulary. */
export type DocumentEnvironment = "dev" | "test" | "production" | "unknown";

/** {@link Fidelity.dataSensitivity}. */
export type DataSensitivity = "synthetic" | "real-subject";

/** {@link Bot.transport}. */
export type BotTransportKind = "http" | "iframe";

/** {@link Bot.delivery} — `http` transport only. */
export type BotDelivery = "webhook" | "polling";

/** {@link Cast.type}. */
export type CastType = "ai-agent" | "human";

/** {@link Provider.kind}. */
export type ProviderKind = "model" | "cassette";

/** {@link Provider.mode} — `cassette` kind only. */
export type CassetteMode = "replay" | "record";

/** {@link Part.kind}. */
export type PartKind = "ai-goal" | "deterministic";

/** {@link Part.failurePolicy}; omitted means `"abort"`. */
export type DocumentFailurePolicy = "abort" | "coverage-gap";

/** {@link Condition.field} — v1's journal-expectation field vocabulary. */
export type ConditionField = "kind" | "direction" | "text" | "edited";

/** {@link Condition.op}. */
export type ConditionOp = "exact" | "contains" | "regex";

/**
 * The only legal shape for a secret-bearing field: a JSON object carrying
 * exactly one member, `secretRef`, naming a {@link Secret} declared in
 * {@link Document.secrets}. See `document-secrets.ts`'s `checkSecretRefShape`
 * for the strict, no-sibling-member decode this type's own presence in a
 * parsed {@link Document} already guarantees.
 */
export interface SecretRef {
  readonly secretRef: string;
}

/** Exactly one of `env` or `credential` — where a declared {@link Secret} resolves from. */
export interface SecretSource {
  readonly env?: string;
  readonly credential?: string;
}

/** A declared secret *name* and where the runner resolves it from — never a value. */
export interface Secret {
  readonly name: string;
  readonly from: SecretSource;
}

/**
 * `fidelity` declares a document's endpoint profile, environment and data
 * sensitivity — required, because a result that does not name these is not a
 * result (principle 4). `redactionPolicy` is this format's minimal,
 * provisional answer to "where does a redaction policy live": a non-empty
 * policy name, required exactly when `dataSensitivity` is `"real-subject"`.
 */
export interface Fidelity {
  readonly endpointProfile: EndpointProfile | string;
  readonly environment?: DocumentEnvironment | string;
  readonly dataSensitivity?: DataSensitivity | string;
  readonly redactionPolicy?: string;
}

/**
 * One declared chat — exactly one in v1. `id` is document-local; a
 * {@link DocumentPart}'s `chat` and {@link Verify.chat} reference it.
 *
 * @remarks
 * Named `DocumentChat` (not the bare `Chat` the format README itself uses)
 * because `../expect/chat.js` already exports a `Chat` class for this
 * package's deterministic scenario verbs — the two are unrelated concepts
 * that happen to share the format's own vocabulary; the rename avoids an
 * ambiguous `export *` at the package's top level (`src/index.ts`).
 */
export interface DocumentChat {
  readonly id: string;
  readonly platformChatId: number;
}

/**
 * Declares how the runtime reaches the bot under test and, at the same time,
 * its roster identity. Exactly one of `url` or `exampleBot` is present.
 */
export interface Bot {
  readonly id: string;
  readonly name: string;
  /** Required with `url`, forbidden with `exampleBot`. */
  readonly transport?: BotTransportKind | string;
  /** `http` transport only. */
  readonly delivery?: BotDelivery | string;
  /** The bot's webhook URL, or the iframe `src`. Required for iframe and http+webhook; forbidden for http+polling. */
  readonly url?: string;
  /** Optional request headers for webhook delivery; each value is a secret reference. */
  readonly headers?: Readonly<Record<string, SecretRef>>;
  /** Names an example bot the runtime itself ships (e.g. `"greetbot"`). Not an extension point. */
  readonly exampleBot?: string;
}

/** A cast member's platform-native identity — one declaration serving both the roster entry and the user a loop acts as. */
export interface PlatformIdentity {
  readonly userId: number;
  readonly firstName?: string;
}

/**
 * An ai-agent cast member's provider declaration — a discriminated union on
 * `kind`, encoded as one flat JSON object (mirroring Go's `Provider`, which
 * has no native sum-type support either). Exactly the fields belonging to
 * `kind` are meaningful; see `document-validate.ts` for which combinations
 * are legal.
 *
 * @remarks
 * Named `DocumentProvider` (not the bare `Provider` the format README itself
 * uses) because `../actor/provider.js` already exports a `Provider` interface
 * — the runtime's own actor-transport contract, an unrelated concept this
 * one resolves *to* (see `document-build.ts`'s `resolveProvider`). The
 * rename avoids an ambiguous `export *` at the package's top level.
 */
export interface DocumentProvider {
  readonly kind: ProviderKind | string;

  // model-kind fields.
  readonly providerId?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKey?: SecretRef;

  // cassette-kind fields.
  readonly mode?: CassetteMode | string;
  readonly cassette?: string;
  /** `mode: "record"` only — a model provider. */
  readonly wraps?: DocumentProvider;
}

/** One non-bot participant. */
export interface Cast {
  readonly id: string;
  readonly type: CastType | string;
  readonly name: string;
  readonly platformIdentity: PlatformIdentity;
  /** Set for an `"ai-agent"` cast member; absent for `"human"` (v1 has no way to author a scripted actor). */
  readonly provider?: DocumentProvider;
}

/** A document-declared input. Provisional shape — see the format README's "Not in v1" section. */
export interface InputDecl {
  readonly name: string;
  readonly description?: string;
  readonly default?: unknown;
}

/** A document-declared named input binding. Provisional shape, matching {@link InputDecl}. */
export interface CaseDecl {
  readonly name: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** One task inside a {@link DocumentGoal}. */
export interface DocumentTask {
  readonly id: string;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  readonly successCriteria: string;
  readonly milestones?: readonly string[];
}

/**
 * Authored budgets, with integer seconds instead of a nanosecond duration —
 * see the format README's "Durations are integer seconds" rule. At least one
 * of `maxSteps`, `maxDurationSeconds` or `maxCost` must be a positive value
 * for an `ai-goal` part (checked by `document-validate.ts`); the runtime
 * `Budgets`' own "zero/absent means unlimited" convention is deliberately
 * NOT inherited by the authoring format itself.
 */
export interface DocumentBudgets {
  readonly maxSteps?: number;
  readonly maxDurationSeconds?: number;
  readonly maxCost?: number;
}

/** `goal.Goal`, authored. */
export interface DocumentGoal {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly tasks: readonly DocumentTask[];
  readonly constraints?: readonly string[];
  readonly budgets: DocumentBudgets;
}

/**
 * `actor.Config`'s authorable tunables, with integer seconds — see the format
 * README's "loop" paragraph for each field's default, identical in both
 * runtimes: `historyWindow` (10), `nonProgressLimit` (3),
 * `actWaitTimeoutSeconds` (5), `retainObservations` (true), `overshootProbe`
 * (true). `retainObservations`/`overshootProbe` are optional booleans so
 * "omitted" (defaults to `true`) is distinguishable from an explicit `false`.
 */
export interface DocumentLoopConfig {
  readonly historyWindow?: number;
  readonly nonProgressLimit?: number;
  readonly actWaitTimeoutSeconds?: number;
  readonly retainObservations?: boolean;
  readonly overshootProbe?: boolean;
}

/**
 * One ordered passage of the run. Maps onto {@link "../run/run.js".AIGoalPart}
 * member for member (for `kind: "ai-goal"` — the only kind v1 executes).
 *
 * @remarks
 * Named `DocumentPart` (not the bare `Part` the format README itself uses)
 * because `../run/run.js` already exports a `Part` type (`DeterministicPart |
 * AIGoalPart`) — the runtime's own executable-passage contract, which this
 * type maps *onto* (see `document-build.ts`). The rename avoids an ambiguous
 * `export *` at the package's top level.
 */
export interface DocumentPart {
  readonly id: string;
  readonly kind: PartKind | string;
  readonly title?: string;
  readonly chat: string;
  readonly actorId: string;
  readonly failurePolicy?: DocumentFailurePolicy | string;
  /** Set for `kind: "ai-goal"`. */
  readonly goal?: DocumentGoal;
  /** Optionally overrides the loop tunables. */
  readonly loop?: DocumentLoopConfig;
  /**
   * Reserved for `kind: "deterministic"` (action matchers — not built; see
   * the format README's "Reserved for action matchers" section). Its
   * presence is never inspected beyond "this document declares a
   * deterministic part", which `document-validate.ts` always rejects in v1.
   */
  readonly steps?: unknown;
}

/** Run-level aggregate ceiling across `ai-goal` parts, with integer seconds. Optional; absence is *reported*, not silently accepted. */
export interface Ceiling {
  readonly maxSteps?: number;
  readonly maxCost?: number;
  readonly maxDurationSeconds?: number;
}

/** A `{field, op, value}` triple with an optional `negate` — one journal-expectation condition. */
export interface Condition {
  readonly field: ConditionField | string;
  readonly op: ConditionOp | string;
  readonly value: unknown;
  readonly negate?: boolean;
}

/** One ordered journal expectation — see {@link Verify}. */
export interface JournalExpectation {
  readonly id: string;
  readonly unmetDetail: string;
  readonly all: readonly Condition[];
}

/** The declarative form of an independent journal re-check — see `document-verify.ts`. */
export interface Verify {
  readonly chat: string;
  readonly metDetail: string;
  readonly journal: readonly JournalExpectation[];
}

/**
 * The parsed, validated shape of one scenario-document/v1 file. Field order
 * mirrors the format README's "Shape" table (and `runtime-go`'s `Document`
 * struct).
 */
export interface Document {
  readonly format: string;
  readonly schemaVersion: number;

  readonly id: string;
  readonly version: string;
  readonly title: string;

  readonly description?: string;
  readonly requires?: readonly string[];

  readonly fidelity: Fidelity;
  readonly platform: string;
  readonly chats: readonly DocumentChat[];
  readonly bot: Bot;
  readonly cast: readonly Cast[];

  readonly secrets?: readonly Secret[];

  readonly inputs?: readonly InputDecl[];
  readonly cases?: readonly CaseDecl[];

  readonly parts: readonly DocumentPart[];

  readonly ceiling?: Ceiling;
  readonly verify?: Verify;

  readonly verifies?: readonly string[];
}

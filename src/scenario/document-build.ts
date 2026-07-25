/**
 * Build: the separate, explicit step that maps an already-validated
 * {@link Document} onto an executable {@link Run} — ported in *spirit* from
 * `runtime-go`'s `scenario/build.go`, deliberately narrower in *scope*. See
 * the module-level gaps called out below; each is reported, never papered
 * over (principle 4, "fidelity is declared").
 *
 * @remarks
 * **What this module supports today:** `bot.exampleBot === "greetbot"` only
 * — the one cross-runtime conformance fixture (the format README: "Today no
 * bot transport is supported by both runtimes ... exampleBot is consequently
 * the only transport-neutral endpoint"). A `url`-addressed bot (`http` or
 * `iframe`) is refused by name here, not because `document-validate.ts`
 * rejects the document (it does not — `iframe` validates cleanly in
 * `runtime-ts`) but because wiring a live `IframeHost`/webhook transport
 * from a parsed document is follow-up work this task does not attempt.
 *
 * **Cassette playback is not implemented in `runtime-ts`.** A `cassette`-kind
 * provider on the `"greetbot"` exampleBot is satisfied by substituting the
 * repository's own hand-authored, deterministic
 * {@link "./greetbot.js".GreetbotProvider} policy — it drives exactly the
 * same happy path a recorded cassette would replay, at zero network/token
 * cost, but it is a fixture-specific substitution, not a general cassette
 * engine. The substitution is recorded in {@link BuiltScenario.providerOverrides},
 * never silently presented as "the document's own declaration ran" (the
 * format README's own rule for a runner overriding a declared provider). A
 * `cassette`-kind provider on any other bot, and every `model`-kind provider,
 * is refused by name — see {@link ScenarioBuildError}.
 *
 * **`failurePolicy` and `ceiling` are accepted and validated, never
 * enforced.** `runtime-ts`'s own `run` package does not implement
 * `FailurePolicy`/`RunCeiling` semantics yet — a pre-existing gap this
 * module inherits and does not attempt to close (see
 * `runtime-ts/docs/runtime-parity.md`, "Part 2" item 5). Every part runs to
 * completion regardless of a sibling part's `failurePolicy` or `ceiling`
 * declaration.
 */

import type { PlatformUser } from "../platform/codec.js";
import { Session, type SessionActor } from "../session/session.js";
import type { AIGoalPart, Run, RunProgress } from "../run/run.js";
import { GreetbotProvider } from "./greetbot.js";
import { createExampleBotTransport } from "./examplebots.js";
import { compileVerify, type VerifySpec } from "./document-verify.js";
import { resolveFidelity, type ResolvedFidelity } from "./document-fidelity.js";
import { toRuntimeGoal } from "./document-validate.js";
import type { Cast, Document, DocumentLoopConfig, DocumentPart, DocumentProvider } from "./document.js";

/** Thrown for a Build-time refusal — always naming exactly what is unsupported, never a silent fallback (principle 4). */
export class ScenarioBuildError extends Error {
  constructor(message: string) {
    super(`scenario: ${message}`);
    this.name = "ScenarioBuildError";
  }
}

/**
 * One provider substitution `buildScenarioRun` performed — the evidence the
 * format README requires when "a runner overrides a declared provider":
 * never present the document's own declaration as what actually ran.
 */
export interface ProviderOverrideNote {
  readonly castId: string;
  readonly declaredKind: string;
  readonly ranAs: string;
  readonly reason: string;
}

/** Options for {@link buildScenarioRun}. */
export interface BuildScenarioOptions {
  /** The built run's clock (epoch ms). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Forwarded to {@link "../run/run.js".ExecuteOptions.onProgress} by a caller driving {@link "../run/run.js".executeRun} — not used by Build itself; accepted here only so a caller can build options once. */
  readonly onProgress?: (progress: RunProgress) => void;
}

/** Everything {@link buildScenarioRun} produced from a validated {@link Document}. */
export interface BuiltScenario {
  readonly run: Run;
  /** The session the run's bot endpoint is wired into — a caller needs it to read chat journals or assemble a run bundle afterward. */
  readonly session: Session;
  /** The document's compiled independent verification, or `undefined` when it declares none — see the format README's judged-vs-verified rule. */
  readonly verify?: VerifySpec;
  readonly fidelity: ResolvedFidelity;
  /** Doc-local chat id -> platform chat id, matching `runtime-go`'s `Built.ChatIDs`. */
  readonly chatIdByDocId: ReadonlyMap<string, number>;
  readonly providerOverrides: readonly ProviderOverrideNote[];
}

/**
 * Maps `doc` — already parsed and validated by {@link
 * "./document-parse.js".parseScenarioDocument} — onto a ready-to-execute
 * {@link Run}. Throws {@link ScenarioBuildError} for anything outside this
 * module's declared scope (see the module doc comment); never silently
 * approximates.
 */
export function buildScenarioRun(doc: Document, options: BuildScenarioOptions = {}): BuiltScenario {
  if (doc.bot.exampleBot !== "greetbot") {
    throw new ScenarioBuildError(
      `buildScenarioRun supports only bot.exampleBot === "greetbot" today; ${describeBotEndpoint(doc.bot)} is not wired — see docs/runtime-parity.md`,
    );
  }

  const chatIdByDocId = new Map(doc.chats.map((c) => [c.id, c.platformChatId] as const));
  const castById = new Map(doc.cast.map((c) => [c.id, c] as const));

  const session = new Session({
    bot: { id: doc.bot.id, type: "bot", name: doc.bot.name },
    human: firstAiAgentRosterEntry(doc.cast),
  });
  session.registerBot(createExampleBotTransport("greetbot"));

  const now = options.now ?? (() => Date.now());
  const providerOverrides: ProviderOverrideNote[] = [];
  const verifySpec = compileVerify(doc);

  const parts: AIGoalPart[] = doc.parts.map((p) => buildAIGoalPart(p, castById, chatIdByDocId, verifySpec, providerOverrides));

  const run: Run = {
    id: doc.id,
    environment: { session, chatIds: [...chatIdByDocId.values()], now },
    parts,
  };

  return { run, session, verify: verifySpec, fidelity: resolveFidelity(doc), chatIdByDocId, providerOverrides };
}

function buildAIGoalPart(
  p: DocumentPart,
  castById: ReadonlyMap<string, Cast>,
  chatIdByDocId: ReadonlyMap<string, number>,
  verifySpec: VerifySpec | undefined,
  providerOverrides: ProviderOverrideNote[],
): AIGoalPart {
  if (p.kind !== "ai-goal" || p.goal === undefined) {
    // document-validate.ts already rejects any other kind/absent goal before
    // Build ever runs — reaching this means the caller skipped validation.
    throw new ScenarioBuildError(`part "${p.id}": Build requires an already-validated ai-goal part`);
  }
  const chatId = chatIdByDocId.get(p.chat);
  if (chatId === undefined) throw new ScenarioBuildError(`part "${p.id}": chat "${p.chat}" is not declared`);

  const cast = castById.get(p.actorId);
  if (cast === undefined || cast.type !== "ai-agent" || cast.provider === undefined) {
    throw new ScenarioBuildError(`part "${p.id}": actor "${p.actorId}" has no ai-agent provider`);
  }

  const provider = resolveProvider(cast, providerOverrides);
  const user: PlatformUser = { id: cast.platformIdentity.userId, firstName: cast.platformIdentity.firstName ?? "" };

  return {
    kind: "ai-goal",
    id: p.id,
    title: p.title,
    actorId: p.actorId,
    chatId,
    user,
    goal: toRuntimeGoal(p.goal),
    provider,
    loop: toRuntimeLoopConfig(p.loop),
    verify: verifySpec !== undefined && verifySpec.chatDocId === p.chat ? (entries) => verifySpec.evaluate(entries) : undefined,
  };
}

/**
 * Resolves one cast member's declared provider to a runtime {@link
 * "../actor/provider.js".Provider}. Only a `"cassette"`+`"replay"` provider
 * on the `"greetbot"` exampleBot is satisfied — by the shipped
 * {@link GreetbotProvider} policy, recorded as an override (see the module
 * doc comment's cassette-playback gap). Every other kind/mode is refused by
 * name.
 */
function resolveProvider(cast: Cast, providerOverrides: ProviderOverrideNote[]): import("../actor/provider.js").Provider {
  const provider = cast.provider as DocumentProvider;
  if (provider.kind === "cassette" && provider.mode === "replay") {
    providerOverrides.push({
      castId: cast.id,
      declaredKind: `cassette (${provider.cassette ?? ""})`,
      ranAs: "greetbot-policy (GreetbotProvider)",
      reason:
        'runtime-ts has no cassette-replay engine (see docs/runtime-parity.md, "AI cassette record/replay"); substituting the shipped deterministic greetbot policy provider, which drives the same happy path a recorded cassette would replay',
    });
    return new GreetbotProvider();
  }
  const mode = provider.mode !== undefined ? ` mode "${provider.mode}"` : "";
  throw new ScenarioBuildError(`cast "${cast.id}": provider kind "${provider.kind}"${mode} is not wired by runtime-ts's Build yet — see docs/runtime-parity.md`);
}

function toRuntimeLoopConfig(lc: DocumentLoopConfig | undefined): AIGoalPart["loop"] {
  if (lc === undefined) return undefined;
  return {
    historyWindow: lc.historyWindow,
    nonProgressLimit: lc.nonProgressLimit,
    actWaitTimeoutMs: lc.actWaitTimeoutSeconds !== undefined ? lc.actWaitTimeoutSeconds * 1000 : undefined,
    disableObservationRetention: lc.retainObservations === false ? true : undefined,
    disableOvershootProbe: lc.overshootProbe === false ? true : undefined,
  };
}

function firstAiAgentRosterEntry(cast: readonly Cast[]): SessionActor | undefined {
  const member = cast.find((c) => c.type === "ai-agent");
  return member === undefined ? undefined : { id: member.id, type: member.type, name: member.name };
}

function describeBotEndpoint(bot: Document["bot"]): string {
  if (bot.exampleBot !== undefined && bot.exampleBot !== "") return `bot.exampleBot "${bot.exampleBot}"`;
  if (bot.transport !== undefined) return `bot.transport "${bot.transport}"`;
  return "this bot endpoint";
}

/**
 * The runtime orchestrator: the top-level object embedded in the Studio
 * Playground/player component, named "runtime" as an architectural term —
 * not a change to website structure (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}).
 *
 * @remarks
 * A `ChatwrightRuntime` is where the three seams meet: it holds a bot
 * registry keyed by {@link BotId}, routes platform updates and calls
 * through each bot's {@link "../transport/transport.js".BotTransport}
 * using the platform's {@link "../platform/codec.js".PlatformCodec}, and
 * journals every exchange via {@link "../journal/journal.js".Journal}.
 * None of that orchestration is designed yet — this interface only names
 * the two operations a caller will need and leaves everything about
 * scenario execution, request routing, response correlation, recording and
 * replay to research item I-66 ("Browser runtime internals").
 *
 * Signatures here are deliberately provisional: types are branded stand-ins
 * for concepts (bot identity, a run handle) that I-66 will design properly,
 * not a committed API surface. Expect both methods' shapes to change.
 */

/**
 * A bot's identity within one runtime instance's registry.
 *
 * @remarks
 * Branded `string` placeholder — deliberately not fleshed out into a
 * record type until I-66 settles what a bot registration needs to carry
 * (transport choice, manifest reference, declared capabilities, …).
 */
export type BotId = string & { readonly __brand: "BotId" };

/**
 * What {@link ChatwrightRuntime.registerBot} needs to know about a bot
 * before it can route traffic to it.
 *
 * @remarks
 * Placeholder shape. A real registration will almost certainly need the
 * platform, a transport instance or transport-construction parameters, and
 * a manifest reference (decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0013-chatwright-md-federation.md | 0013}'s
 * `CHATWRIGHT.md`) — none of that is decided here.
 */
export interface BotRegistration {
  readonly platform: string;
  /** @remarks TODO(I-66): replace with a real transport/manifest reference. */
  readonly todo: unknown;
}

/**
 * A live or completed run, as handed back by
 * {@link ChatwrightRuntime.run}.
 *
 * @remarks
 * Branded `string` placeholder standing in for whatever object I-66 (and
 * I-69, for recording/replay) decide should represent an in-progress run —
 * at minimum something that exposes the run's {@link
 * "../journal/journal.js".Journal} for the player to subscribe to.
 */
export type RunHandle = string & { readonly __brand: "RunHandle" };

/**
 * What running a scenario needs, minimally.
 *
 * @remarks
 * Placeholder shape — the real parameters (which bot(s), which scenario
 * representation, initial state, budgets) are research item I-66's to
 * design, informed by I-71's portable scenario format.
 */
export interface RunOptions {
  readonly botId: BotId;
  /** @remarks TODO(I-66): replace with a real scenario reference. */
  readonly todo: unknown;
}

/**
 * The orchestrator seam of the browser runtime.
 *
 * @remarks
 * Responsibilities named by decision 0012 that a `ChatwrightRuntime`
 * implementation will eventually own: scenario execution, the bot
 * registry, request routing, response correlation, platform emulation,
 * transport abstraction, recording, replay and state. This scaffold
 * commits to none of the internals — see research item I-66.
 */
export interface ChatwrightRuntime {
  /**
   * Adds a bot to this runtime's registry, making it addressable by the
   * {@link BotId} this method returns.
   */
  registerBot(registration: BotRegistration): BotId;

  /**
   * Starts executing a scenario against a registered bot and returns a
   * handle to the run.
   */
  run(options: RunOptions): RunHandle;
}

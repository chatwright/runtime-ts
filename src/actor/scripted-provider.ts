/**
 * {@link ScriptedProvider}: a deterministic, zero-network {@link Provider} for
 * tests and the CI replay gate, ported from the Go runtime's
 * `actor/scripted_provider.go`.
 */

import type { Prompt, Proposal, ProposeResult, Provider, Usage } from "./provider.js";

/** Thrown when a {@link ScriptedProvider}'s `propose` is called more times than its script has entries. */
export class ScriptExhaustedError extends Error {
  constructor(scripted: number, taskId: string) {
    super(
      `actor: scripted provider's script is exhausted: ${scripted} proposals scripted, asked for one more at task "${taskId}"`,
    );
    this.name = "ScriptExhaustedError";
  }
}

/**
 * A deterministic provider driven by a fixed, ordered script of
 * {@link Proposal}s — no model, no network, no cassette. A campaign run
 * against a `ScriptedProvider` is exactly reproducible on its own, at zero
 * cost, every time.
 *
 * @remarks
 * It ignores the {@link Prompt} it is given — it is a fixed sequence, not a
 * policy — so a caller that needs to react to what is actually observed (for
 * example an opaque {@link "../observe/observe.js".AvailableAction.id} only
 * known once the conversation is under way) should supply a bespoke
 * {@link Provider} instead.
 */
export class ScriptedProvider implements Provider {
  readonly #usage: Usage;
  readonly #script: readonly Proposal[];
  #next = 0;

  /**
   * Builds a provider that proposes each of `script`'s entries in order, one
   * per `propose` call, always reporting `usage` verbatim.
   */
  constructor(usage: Usage, ...script: readonly Proposal[]) {
    this.#usage = usage;
    this.#script = [...script];
  }

  /** Returns the next scripted proposal, or throws {@link ScriptExhaustedError} once the script runs out. */
  async propose(prompt: Prompt): Promise<ProposeResult> {
    if (this.#next >= this.#script.length) {
      throw new ScriptExhaustedError(this.#script.length, prompt.taskId);
    }
    const proposal = this.#script[this.#next]!;
    this.#next++;
    return { proposal, usage: this.#usage };
  }
}

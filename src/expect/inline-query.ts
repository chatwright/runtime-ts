import type { PlatformInlineQueryAnswer } from "../platform/codec.js";
import type { Session } from "../session/session.js";

/** A lazy deterministic expectation for a platform-native inline answer. */
export class InlineQueryExpectation {
  private answerPromise: Promise<PlatformInlineQueryAnswer> | undefined;

  constructor(
    private readonly session: Session,
    readonly queryId: string,
    private readonly safetyTimeoutMs: number,
  ) {}

  /** Asserts the result count and returns this expectation for subsequent checks. */
  async expectResultCount(want: number): Promise<this> {
    const answer = await this.resolve();
    if (answer.results.length !== want) {
      throw new Error(
        `chatwright: inline result count = ${answer.results.length}, want ${want}`,
      );
    }
    return this;
  }

  /** Returns a detached normalized inline answer. */
  async snapshot(): Promise<PlatformInlineQueryAnswer> {
    return cloneInlineAnswer(await this.resolve());
  }

  private resolve(): Promise<PlatformInlineQueryAnswer> {
    this.answerPromise ??= this.session.waitForInlineQueryAnswer(
      this.queryId,
      this.safetyTimeoutMs,
    );
    return this.answerPromise;
  }
}

function cloneInlineAnswer(answer: PlatformInlineQueryAnswer): PlatformInlineQueryAnswer {
  return {
    ...answer,
    results: answer.results.map((result) => ({
      ...result,
      ...(result.actions
        ? { actions: result.actions.map((row) => row.map((action) => ({ ...action }))) }
        : {}),
    })),
  };
}

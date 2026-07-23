/**
 * `BotMessageExpectation` — the fluent handle to one bot message a scenario
 * has just observed, returned by {@link "./chat.js".Chat.expectBotMessage}
 * and {@link "./chat.js".Chat.expectEdited}. The TypeScript twin of
 * `runtime-go`'s `cw.BotMessage` (`chatwright/runtime-go/cw/expect.go`),
 * ported as an algorithm per decision
 * {@link https://github.com/chatwright/chatwright/blob/main/spec/decisions/0012-black-box-bot-protocol.md | 0012}
 * — see that module's doc comment for the full deviation list versus Go
 * (naming, and `within` asserting rather than extending the wait).
 */

import type { JournalAction, JournalEntry } from "../journal/journal.js";

/** What {@link BotMessageExpectation} needs back from its owning chat: a transcript for failure messages. */
export interface TranscriptSource {
  transcript(): string;
}

/** A message identity + version, as needed to target {@link "./chat.js".Chat.expectEdited}. */
export interface MessageRef {
  readonly messageId: number;
  readonly version: number;
}

/**
 * A fluent, already-resolved handle to one bot message. Unlike Go's
 * `cw.BotMessage` — which is returned *before* the wait happens and blocks
 * lazily the first time an assertion method is called on it — this handle
 * is only ever constructed after the message has actually arrived (`Chat`'s
 * `expectBotMessage`/`expectEdited` are `async` and only resolve to one of
 * these once the underlying `Promise` settles). There is deliberately no
 * "unresolved" state to guard against here — see `docs/architecture.md`.
 */
export class BotMessageExpectation implements MessageRef {
  readonly messageId: number;
  readonly version: number;

  private readonly rawText: string;
  private readonly rawActions: readonly (readonly JournalAction[])[];
  private readonly latencyMs: number;
  private readonly source: TranscriptSource;

  constructor(source: TranscriptSource, entry: JournalEntry, latencyMs: number) {
    this.source = source;
    this.messageId = entry.messageId;
    this.version = entry.version;
    this.rawText = entry.text;
    this.rawActions = entry.actions ?? [];
    this.latencyMs = latencyMs;
  }

  /** The message's current text, exactly as sent (or as last edited). */
  text(): string {
    return this.rawText;
  }

  /** The message's action rows exactly as sent (or as last edited), Telegram row/col layout preserved. */
  actions(): readonly (readonly JournalAction[])[] {
    return this.rawActions;
  }

  /** Milliseconds between the chat's last inbound action (`sendText`/`click`) and this message's arrival. */
  latency(): number {
    return this.latencyMs;
  }

  /** A `{messageId, version}` ref suitable for `Chat.expectEdited` — equivalent to passing `this` directly. */
  ref(): MessageRef {
    return { messageId: this.messageId, version: this.version };
  }

  /** Asserts the message's text equals `want` exactly. Returns `this` for chaining. */
  expectText(want: string): this {
    if (this.rawText !== want) {
      throw new Error(
        `chatwright: bot message text = ${JSON.stringify(this.rawText)}, want ${JSON.stringify(want)}\n${this.source.transcript()}`,
      );
    }
    return this;
  }

  /**
   * Asserts the message's action labels, flattened row-major (row 0 left to
   * right, then row 1, ...), equal `labels` exactly — same length, same
   * order, no extras and none missing.
   */
  expectActions(...labels: readonly string[]): this {
    const flat = this.flattenLabels();
    const matches = flat.length === labels.length && flat.every((label, i) => label === labels[i]);
    if (!matches) {
      throw new Error(
        `chatwright: bot message actions = ${JSON.stringify(flat)}, want ${JSON.stringify(labels)}\n${this.source.transcript()}`,
      );
    }
    return this;
  }

  /**
   * Asserts this message's observed latency (time from the chat's last
   * inbound action to this message's arrival) is within `ms` — checked
   * once, against the latency already recorded when the message arrived
   * ("asserted after arrival", never a wait window of its own: unlike Go's
   * `Within`, it cannot retroactively extend how long `expectBotMessage`/
   * `expectEdited` waited — see `docs/architecture.md` for why). Returns
   * `this` for chaining.
   */
  within(ms: number): this {
    if (this.latencyMs > ms) {
      throw new Error(
        `chatwright: reply arrived after ${this.latencyMs}ms, budget ${ms}ms: ${JSON.stringify(this.rawText)}\n${this.source.transcript()}`,
      );
    }
    return this;
  }

  private flattenLabels(): string[] {
    const flat: string[] = [];
    for (const row of this.rawActions) {
      for (const action of row) flat.push(action.label);
    }
    return flat;
  }
}

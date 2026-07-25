/**
 * The `exampleBot` registry `document-build.ts` boots a `Bot.exampleBot`
 * reference from — the browser-native counterpart of `runtime-go`'s
 * `scenario/examplebots.go`. Its key set MUST equal
 * `document-validate.ts`'s `DEFAULT_SUPPORTED_EXAMPLE_BOTS` (an id present
 * in one without a matching entry here is a packaging bug, not a document
 * problem — the same invariant Go states for its own registry).
 *
 * @remarks
 * `"greetbot"` is the only entry, exactly as in `runtime-go`. The
 * *implementation* differs per runtime — Go boots
 * `chatwright.dev/runtime/examples/greetbot` behind an `httptest.Server`;
 * this registry wires `../testkit/greetbot-bot.js`'s in-process reactive fake
 * directly as a {@link BotTransport} — but the id is language-neutral (the
 * format README's own rule for `exampleBot`). `GreetbotBot` was written as
 * this repository's own greetbot e2e test's bot-under-test; it is promoted
 * here to also be the scenario-document format's shipped `exampleBot`, which
 * is why it is exported from this module even though its own file remains
 * primarily test-support code.
 */

import type { BotTransport } from "../transport/transport.js";
import { GreetbotBot } from "../testkit/greetbot-bot.js";

/** Boots a fresh {@link BotTransport} for one exampleBot id. Every call gets fresh state. */
export type ExampleBotTransportFactory = () => BotTransport;

/** Thrown by {@link createExampleBotTransport} for an id this registry does not carry. `document-validate.ts`'s own `requires` check should already have refused an undeclared exampleBot id before Build ever runs. */
export class UnknownExampleBotError extends Error {
  constructor(id: string) {
    super(`scenario: no exampleBot registered for "${id}"`);
    this.name = "UnknownExampleBotError";
  }
}

/** The exampleBot ids this runtime ships, mapped to a fresh-transport factory. */
export const DEFAULT_EXAMPLE_BOTS: ReadonlyMap<string, ExampleBotTransportFactory> = new Map([["greetbot", () => new GreetbotBot()]]);

/** Boots a fresh {@link BotTransport} for `id` against {@link DEFAULT_EXAMPLE_BOTS}, throwing {@link UnknownExampleBotError} for an unregistered id. */
export function createExampleBotTransport(id: string): BotTransport {
  const factory = DEFAULT_EXAMPLE_BOTS.get(id);
  if (factory === undefined) throw new UnknownExampleBotError(id);
  return factory();
}

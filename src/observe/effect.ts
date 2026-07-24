/**
 * The "genuine bot-authored content change" judgement the actor loop uses to
 * tell real progress from an idempotent re-render — ported from the Go
 * runtime's `actor/loop.go` (`observedEffect`, `semanticallyEqualMessage`).
 *
 * @remarks
 * These are pure comparisons over {@link Observation}s. The actor loop (a
 * follow-up slice) supplies the re-observation itself and consumes
 * {@link observedBotEffect} to decide whether an action produced a
 * semantically observable effect; keeping the comparison here, separate from
 * `observe`'s own truthful {@link Change} feed, keeps the two concerns
 * distinct instead of collapsing into "any change means progress".
 */

import type { Observation, VisibleMessage } from "./observe.js";

/**
 * Reports whether `a` and `b` — two observations of the same logical message,
 * at possibly different versions — carry the same user-visible content:
 * identical text and the same action labels in the same layout.
 *
 * @remarks
 * It deliberately compares actions by LABEL, never by id: an
 * {@link "./observe.js".AvailableAction.id} encodes the owning message's
 * version, so it changes on every edit by design — comparing ids would report
 * every re-render as a change, which is exactly the false "progress" signal
 * this function exists to avoid.
 */
export function semanticallyEqualMessage(
  a: VisibleMessage,
  b: VisibleMessage,
): boolean {
  if (a.text !== b.text) return false;
  if (a.actions.length !== b.actions.length) return false;
  for (let i = 0; i < a.actions.length; i++) {
    if (a.actions[i]!.label !== b.actions[i]!.label) return false;
  }
  return true;
}

/** Returns the message with the given id from `messages`, or `undefined`. */
export function findMessageById(
  messages: readonly VisibleMessage[],
  id: string,
): VisibleMessage | undefined {
  return messages.find((message) => message.id === id);
}

/**
 * Reports whether the bot reacted with a semantic effect between `preAction`
 * (the Observation the loop acted from) and `fresh` (the Observation
 * re-observed after acting): a new bot message, or an existing bot message
 * whose text or available-action labels actually differ from before.
 *
 * @remarks
 * It deliberately ignores a change whose actor is the user — submitting text
 * or a click always adds the actor's own message/action to the journal, which
 * would otherwise always look like "an effect" even when the bot never
 * responded at all, defeating non-progress detection.
 *
 * It does NOT stop at "some change exists for a bot message": `observe`'s diff
 * keys an `"edited-message"` change off version alone, so a bot that re-edits
 * a message in place with byte-identical text and the same action labels
 * still bumps the version and so still produces a change. That change is a
 * truthful record of what moved, but a content-identical re-render is not
 * progress — {@link semanticallyEqualMessage} tells the two apart.
 *
 * The actor loop performs the re-observation itself and passes both
 * Observations here; this function performs no I/O.
 */
export function observedBotEffect(
  preAction: Observation,
  fresh: Observation,
): boolean {
  const preById = new Map<string, VisibleMessage>();
  for (const message of preAction.messages) preById.set(message.id, message);

  for (const change of fresh.changes) {
    if (change.actor !== "bot") continue;
    const curMsg = findMessageById(fresh.messages, change.messageId);
    if (curMsg === undefined) {
      // Defensive: a bot change naming a message no longer present is not one
      // the loop can dismiss as a no-op re-render.
      return true;
    }
    const prevMsg = preById.get(change.messageId);
    if (prevMsg === undefined || !semanticallyEqualMessage(prevMsg, curMsg)) {
      return true;
    }
  }
  return false;
}

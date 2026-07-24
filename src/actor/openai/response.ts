/**
 * Maps an OpenAI-compatible reply to an {@link "../provider.js".Proposal},
 * never fabricating one — ported from the Go runtime's
 * `actor/openai/response.go`.
 */

import type { Prompt, Proposal, ProposalKind, Usage } from "../provider.js";
import { InvalidResponseError } from "./errors.js";
import type { ChatCompletionResponse } from "./wire.js";

/** The JSON shape {@link "./prompt.js".responseJsonSchema} describes. */
interface WireProposal {
  kind?: string;
  text?: string;
  action_id?: string;
  rationale?: string;
}

/** Field names {@link responseText} can report as its source — see its doc comment for the precedence. */
const FIELD_CONTENT = "content";
const FIELD_REASONING_CONTENT = "reasoning_content";
const FIELD_REASONING = "reasoning";

/** The four proposal kinds, in the vocabulary order the wire contract uses. */
const PROPOSAL_KINDS: readonly ProposalKind[] = ["send-text", "click", "task-done", "give-up"];

/**
 * Extracts `resp`'s first choice's reply text, parses it as a
 * {@link WireProposal} (with one repair attempt), and converts it to a
 * {@link "../provider.js".Proposal}. It never returns a proposal built from an
 * unparseable or contract-violating reply: every failure path throws an
 * {@link InvalidResponseError} naming the field the text was read from and the
 * response's `finish_reason`. `usage`, when supplied, is attached to a thrown
 * error so the caller can still see what the (successful) HTTP call cost.
 */
export function proposalFromResponse(
  resp: ChatCompletionResponse,
  prompt: Prompt,
  usage?: Usage,
): Proposal {
  const rt = responseText(resp);
  if (rt.error) {
    throw new InvalidResponseError({ finishReason: rt.finishReason, cause: rt.error, usage });
  }

  let wp: WireProposal;
  try {
    wp = parseWireProposal(rt.raw);
  } catch (err) {
    throw new InvalidResponseError({
      raw: rt.raw,
      finishReason: rt.finishReason,
      source: rt.source,
      cause: err as Error,
      usage,
    });
  }

  try {
    return toProposal(wp, prompt);
  } catch (err) {
    throw new InvalidResponseError({
      raw: rt.raw,
      finishReason: rt.finishReason,
      source: rt.source,
      cause: err as Error,
      usage,
    });
  }
}

/**
 * Returns the text this package attempts to parse from `resp`'s first choice,
 * which field it came from, and that choice's `finish_reason`.
 *
 * Field precedence, checked in this exact order — the first non-empty field
 * wins outright and every later one is never even inspected:
 *
 * 1. `message.content` — the normal path.
 * 2. `message.reasoning_content` — the LM Studio/DeepSeek-style field some
 *    reasoning models route their ENTIRE reply into, leaving content empty.
 * 3. `message.reasoning` — an alternate field name, checked only when both
 *    content and reasoning_content are empty.
 *
 * Text recovered from a reasoning field is NOT trusted any more than content:
 * it still goes through the same parse and contract validation.
 */
function responseText(resp: ChatCompletionResponse): {
  raw: string;
  source: string;
  finishReason: string;
  error?: Error;
} {
  const choices = resp.choices ?? [];
  if (choices.length === 0) {
    return { raw: "", source: "", finishReason: "", error: new Error("response has no choices") };
  }
  const choice = choices[0]!;
  const message = choice.message ?? {};
  const finishReason = choice.finish_reason ?? "";

  if (message.content) return { raw: message.content, source: FIELD_CONTENT, finishReason };
  if (message.reasoning_content) return { raw: message.reasoning_content, source: FIELD_REASONING_CONTENT, finishReason };
  if (message.reasoning) return { raw: message.reasoning, source: FIELD_REASONING, finishReason };
  return {
    raw: "",
    source: "",
    finishReason,
    error: new Error(`response's first choice has empty content (finish_reason=${finishReason})`),
  };
}

/**
 * Parses `raw` as a {@link WireProposal}, with one repair attempt: if `raw`
 * does not parse as-is (the model wrapped the JSON in prose or a markdown
 * fence), it retries once against the substring from `raw`'s first `{` to its
 * last `}`. A second failure is thrown verbatim — exactly one repair attempt,
 * never more.
 */
function parseWireProposal(raw: string): WireProposal {
  try {
    return asWireProposal(JSON.parse(raw));
  } catch {
    // fall through to the single repair attempt
  }

  const repaired = extractJsonObject(raw);
  if (repaired === undefined) {
    throw new Error("no JSON object found in response text");
  }
  try {
    return asWireProposal(JSON.parse(repaired));
  } catch (err) {
    throw new Error(`unparseable even after one repair attempt: ${(err as Error).message}`);
  }
}

/** Narrows an arbitrary parsed value to a {@link WireProposal}, rejecting non-objects. */
function asWireProposal(value: unknown): WireProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("response is not a JSON object");
  }
  return value as WireProposal;
}

/**
 * Returns the substring of `s` from its first `{` to its last `}`, inclusive —
 * a deliberately simple repair heuristic — or `undefined` when no such span
 * exists.
 */
function extractJsonObject(s: string): string | undefined {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  return s.slice(start, end + 1);
}

/**
 * Converts `wp` to a {@link "../provider.js".Proposal}, checking that the
 * fields its kind requires are actually set. `observationSequence` is never
 * taken from the model's reply: for a `"click"` it is always
 * `prompt.observation.sequence`.
 */
function toProposal(wp: WireProposal, prompt: Prompt): Proposal {
  const rationale = wp.rationale ?? "";
  if (rationale === "") throw new Error('"rationale" is empty');

  const kind = parseProposalKind(wp.kind ?? "");
  switch (kind) {
    case "send-text":
      if (!wp.text) throw new Error('kind "send-text" requires non-empty "text"');
      return { kind, text: wp.text, rationale };
    case "click":
      if (!wp.action_id) throw new Error('kind "click" requires non-empty "action_id"');
      return { kind, actionId: wp.action_id, observationSequence: prompt.observation.sequence, rationale };
    default:
      // task-done, give-up — no further fields required.
      return { kind, rationale };
  }
}

/**
 * Maps `s` to a {@link "../provider.js".ProposalKind}, rejecting both an
 * empty/missing kind and an unrecognised one, rather than silently defaulting.
 */
function parseProposalKind(s: string): ProposalKind {
  if (s === "") throw new Error('"kind" is missing');
  const match = PROPOSAL_KINDS.find((k) => k === s);
  if (match === undefined) throw new Error(`unknown proposal kind "${s}"`);
  return match;
}

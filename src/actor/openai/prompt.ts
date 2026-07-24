/**
 * Renders an {@link "../provider.js".Prompt} to the system+user message pair
 * an OpenAI-compatible `/chat/completions` server expects, and defines the
 * JSON response contract — ported verbatim from the Go runtime's
 * `actor/openai/prompt.go`.
 *
 * @remarks
 * The system prompt and response contract are worded identically to the Go
 * runtime's (and to `actor/anthropic`'s): the `kind`/`text`/`action_id`/
 * `rationale` contract must not vary by provider.
 */

import type { Prompt, Proposal } from "../provider.js";
import type { LoopEvent } from "../loop-event.js";
import type { Observation } from "../../observe/observe.js";

/**
 * Tags the shape {@link renderPrompt} produces and the response contract it
 * asks for. Bump it whenever either changes materially.
 */
export const promptContractVersion = "chatwright-openai-prompt/v1";

/**
 * The system-message half of {@link renderPrompt}: fixed instructions and the
 * response contract. It does not depend on the prompt being rendered, so it is
 * a plain constant.
 */
export const systemPrompt = `You are Chatwright's autonomous conversational test actor (contract ${promptContractVersion}).

You test a real chat bot end to end by acting as its user: you choose exactly one next action toward the active task's success criteria, based only on what is currently visible. You never see platform-internal data (callback payloads, native message IDs) — only user-visible messages and the labelled actions attached to them.

Respond with EXACTLY one JSON object matching the supplied schema. No prose, no markdown code fence, nothing before or after the object.

Choose exactly one "kind":
  - "send-text": send free text as the user. Set "text" to that text; leave "action_id" empty.
  - "click": activate one of the actions listed under "Available actions" below, by its exact "id". Set "action_id" to that id; leave "text" empty. Never invent an id that is not listed there.
  - "task-done": the active task's success criteria are visibly met. Leave "text" and "action_id" empty.
  - "give-up": the active task cannot be completed by further action (a dead end, a bug, an unrecoverable error). Leave "text" and "action_id" empty.

Always set "rationale" to one short, honest sentence explaining the choice. It is recorded for human review — never private chain-of-thought, just enough for a developer to understand why you did this.

If "Recent history" below shows a proposal that was already marked invalid or produced no effect, do not repeat it verbatim — it did not work.`;

/**
 * Deterministically renders `prompt` into the system and user text sent to the
 * chat-completions API. A pure function of `prompt` — no clock, no randomness,
 * no map iteration over the prompt's own data — so the same prompt always
 * renders identical text.
 */
export function renderPrompt(prompt: Prompt): { system: string; user: string } {
  return { system: systemPrompt, user: renderUserPrompt(prompt) };
}

/**
 * A minimal equivalent of Go's `%q` string verb: a double-quoted, escaped
 * string. `JSON.stringify` produces byte-identical output to Go's `%q` for the
 * ASCII text this renderer handles.
 */
function quote(s: string): string {
  return JSON.stringify(s);
}

function renderUserPrompt(prompt: Prompt): string {
  let b = "";

  b += "## Goal\n";
  b += `ID: ${prompt.goalId}\n`;
  b += `Title: ${prompt.goalTitle}\n`;
  if (prompt.goalDescription) b += `Description: ${prompt.goalDescription}\n`;
  if (prompt.constraints && prompt.constraints.length > 0) {
    b += "Constraints:\n";
    for (const c of prompt.constraints) b += `- ${c}\n`;
  }

  b += "\n## Active task\n";
  b += `ID: ${prompt.taskId}\n`;
  b += `Title: ${prompt.taskTitle ?? ""}\n`;
  b += `Success criteria: ${prompt.taskSuccessCriteria ?? ""}\n`;

  b += "\n";
  b += renderObservation(prompt.observation);

  b += "\n";
  b += renderHistory(prompt.history);

  b += "\n## Response contract\n";
  b +=
    'Reply with exactly one JSON object matching the schema: choose one "kind" of ' +
    "send-text | click | task-done | give-up, fill only the fields that kind needs (leave the rest " +
    'as empty strings), and always set "rationale".\n';

  return b;
}

function renderObservation(obs: Observation): string {
  let b = `## Current observation (sequence ${obs.sequence})\n`;

  if (obs.messages.length === 0) {
    b += "No visible messages yet.\n";
  } else {
    b += "Visible messages, oldest to newest:\n";
    for (const m of obs.messages) {
      const edited = m.edited ? " (edited)" : "";
      b += `- [${m.actor}] ${m.id} v${m.version}${edited}: ${quote(m.text)}\n`;
      for (const a of m.actions) {
        b += `    available action: id=${quote(a.id)} label=${quote(a.label)}\n`;
      }
    }
  }

  if (obs.changes.length === 0) {
    b += "Changes since the previous observation: none (first observation).\n";
  } else {
    b += "Changes since the previous observation:\n";
    for (const c of obs.changes) {
      b += `- ${c.kind}: message ${c.messageId} (${c.actor})\n`;
    }
  }
  return b;
}

function renderHistory(history: readonly LoopEvent[]): string {
  if (history.length === 0) {
    return "## Recent history\nNone yet — this is the first attempt at this task.\n";
  }

  let b = `## Recent history (last ${history.length} attempts, oldest first)\n`;
  history.forEach((ev, i) => {
    if (ev.proposal === undefined) {
      // A propose-error event carries no proposal — record the error instead.
      b += `${i + 1}. propose failed: ${ev.proposeError ?? "unknown error"}\n`;
      return;
    }
    b += `${i + 1}. proposed ${describeProposal(ev.proposal)}`;
    if (ev.validation?.checked) {
      b += `; validation=${ev.validation.verdict ?? ""} (${ev.validation.reason ?? ""})`;
    }
    b += `; outcome=${ev.action?.kind ?? ""}`;
    if (ev.action?.detail) b += ` (${ev.action.detail})`;
    b += "\n";
  });
  return b;
}

function describeProposal(p: Proposal): string {
  switch (p.kind) {
    case "send-text":
      return `send-text ${quote(p.text ?? "")}`;
    case "click":
      return `click action_id=${quote(p.actionId ?? "")}`;
    default:
      return p.kind;
  }
}

/**
 * The JSON schema this package asks an OpenAI-compatible server to enforce
 * server-side via `response_format: {"type":"json_schema", ...}` — the SAME
 * proposal JSON contract every provider enforces (kind/text/action_id/
 * rationale, all four always required, an empty string for whichever field the
 * chosen kind does not need). Strict json_schema mode has no notion of
 * "required only when kind is X".
 */
export const responseJsonSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["send-text", "click", "task-done", "give-up"],
      description: "The chosen action kind.",
    },
    text: {
      type: "string",
      description: 'The text to send as the user. Non-empty when kind is "send-text"; empty otherwise.',
    },
    action_id: {
      type: "string",
      description:
        'The exact id of an action listed under "Available actions" in the prompt. Non-empty when kind is "click"; empty otherwise.',
    },
    rationale: {
      type: "string",
      description: "One short, honest sentence explaining the choice, for human review.",
    },
  },
  required: ["kind", "text", "action_id", "rationale"],
  additionalProperties: false,
} as const;

/**
 * Builds the request's `response_format` for the primary, structured-output
 * attempt: OpenAI's `response_format.json_schema` shape (name/strict/schema).
 */
export function jsonSchemaResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "chatwright_proposal",
      strict: true,
      schema: responseJsonSchema,
    },
  };
}

/**
 * Builds the request's `response_format` for the fallback attempt: the older,
 * more widely supported "just some JSON object" contract, with the actual
 * shape restated in the system prompt instead (see
 * {@link jsonObjectFallbackInstructions}).
 */
export function jsonObjectResponseFormat(): Record<string, unknown> {
  return { type: "json_object" };
}

/**
 * Appended to the system prompt only on the json_object fallback attempt: with
 * no server-side schema enforcement, the model needs the shape spelled out in
 * prose instead. Mirrors {@link responseJsonSchema}'s field set exactly.
 */
export const jsonObjectFallbackInstructions = `Your server rejected structured JSON-schema output for this request, so reply as a single plain JSON object matching exactly this shape:
{"kind": "send-text|click|task-done|give-up", "text": "", "action_id": "", "rationale": ""}
All four keys are always present. Use an empty string "" for whichever of "text"/"action_id" the chosen "kind" does not need. Output nothing but that JSON object — no prose, no markdown code fence, nothing before or after it.`;

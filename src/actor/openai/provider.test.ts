import { describe, expect, it } from "vitest";

import type { Prompt } from "../provider.js";
import { OpenAIProvider, DefaultMaxTokens, MissingBaseURLError, MissingModelError, type FetchLike } from "./provider.js";
import { AuthenticationError, InvalidResponseError, RateLimitError } from "./errors.js";

// --- test doubles -----------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A fake {@link FetchLike} that decodes each request body, records it, and
 * answers with whatever `handle` returns — the TS twin of the Go tests'
 * httptest fake server, but with zero network.
 */
function fakeFetch(handle: (body: Record<string, unknown>) => { status: number; body: unknown }): {
  fetchImpl: FetchLike;
  log: RecordedRequest[];
} {
  const log: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    log.push({ url, headers: init.headers, body });
    const { status, body: replyBody } = handle(body);
    const text = typeof replyBody === "string" ? replyBody : JSON.stringify(replyBody);
    return { status, text: async () => text };
  };
  return { fetchImpl, log };
}

/** A deterministic clock advancing by `step` ms per call, starting at 0. */
function stepClock(step: number): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

/** Builds a minimal, valid `/chat/completions` success body carrying `content` as the sole choice's message content. */
function success(model: string, content: string, promptTokens?: number, completionTokens?: number): Record<string, unknown> {
  const resp: Record<string, unknown> = {
    id: "chatcmpl-test",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
  if (promptTokens !== undefined && completionTokens !== undefined) {
    resp.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }
  return resp;
}

/** Like {@link success} but writes the reply into an arbitrary message field (for the reasoning-field tests). */
function successField(model: string, field: string, text: string, finishReason: string): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: "" };
  if (field !== "") message[field] = text;
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 45, total_tokens: 65 },
  };
}

/** An OpenAI-style error envelope. */
function errorEnvelope(type: string, message: string): Record<string, unknown> {
  return { error: { type, message } };
}

const BASE_URL = "http://fake.test/v1";

function newProvider(fetchImpl: FetchLike, apiKey = ""): OpenAIProvider {
  return new OpenAIProvider({ baseURL: BASE_URL, model: "fake-model", apiKey, fetch: fetchImpl, now: stepClock(10) });
}

/** A representative prompt: a goal/task pair, one bot message with one action, and no history. */
function samplePrompt(): Prompt {
  return {
    goalId: "listus-shopping-list",
    goalTitle: "Add items to the shopping list",
    goalDescription: "Verify a user can add multiple items in one message.",
    constraints: ["Do not use admin-only commands."],
    taskId: "add-items",
    taskTitle: "Add milk, eggs, bread",
    taskSuccessCriteria: "The bot confirms the three items were added.",
    observation: {
      sequence: 2,
      previousSequence: 0,
      chat: { chatId: 42 },
      messages: [
        {
          id: "msg7",
          version: 0,
          edited: false,
          actor: "bot",
          text: "What would you like to add?",
          actions: [{ id: "btn-cancel", label: "Cancel", seenAt: 2 }],
        },
      ],
      changes: [],
    },
    history: [],
  };
}

// --- construction -----------------------------------------------------------

describe("OpenAIProvider: construction", () => {
  it("rejects a missing base URL", () => {
    expect(() => new OpenAIProvider({ baseURL: "", model: "m" })).toThrowError(MissingBaseURLError);
  });
  it("rejects a missing model", () => {
    expect(() => new OpenAIProvider({ baseURL: BASE_URL, model: "" })).toThrowError(MissingModelError);
  });
});

// --- wire shape -------------------------------------------------------------

describe("OpenAIProvider.propose: request shape", () => {
  it("POSTs a json_schema structured-output request and maps the reply and usage", async () => {
    const { fetchImpl, log } = fakeFetch(() => ({
      status: 200,
      body: success("fake-model", `{"kind":"send-text","text":"milk, eggs, bread","action_id":"","rationale":"the bot asked what to add"}`, 42, 7),
    }));
    const provider = newProvider(fetchImpl);
    const prompt = samplePrompt();

    const { proposal, usage } = await provider.propose(prompt);

    expect(log).toHaveLength(1);
    const req = log[0]!;
    expect(req.url).toBe(`${BASE_URL}/chat/completions`);
    expect(req.headers["Authorization"]).toBeUndefined();
    expect(req.body.model).toBe("fake-model");
    expect(req.body.max_tokens).toBe(DefaultMaxTokens);

    const format = req.body.response_format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    const jsonSchema = format.json_schema as Record<string, unknown>;
    expect(jsonSchema.strict).toBe(true);
    expect(typeof jsonSchema.schema).toBe("object");

    const messages = req.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("EXACTLY one JSON object");
    expect(messages[1]!.role).toBe("user");
    for (const want of [prompt.goalId, prompt.taskId, prompt.taskSuccessCriteria!, "btn-cancel", "What would you like to add?"]) {
      expect(messages[1]!.content).toContain(want);
    }

    expect(proposal).toEqual({ kind: "send-text", text: "milk, eggs, bread", rationale: "the bot asked what to add" });
    expect(usage.model).toBe("fake-model");
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(7);
    expect(usage.latencyMs).toBeGreaterThan(0);
    expect(usage.cost).toBeUndefined();
    expect(provider.lastResponseFormatMode()).toBe("json_schema");
  });

  it.each([
    ["no API key (local server)", "", undefined],
    ["API key set", "sk-test-123", "Bearer sk-test-123"],
  ] as const)("sends an Authorization header only when an API key is set: %s", async (_name, apiKey, wantHeader) => {
    const { fetchImpl, log } = fakeFetch(() => ({
      status: 200,
      body: success("fake-model", `{"kind":"give-up","text":"","action_id":"","rationale":"r"}`, 1, 1),
    }));
    const provider = newProvider(fetchImpl, apiKey);
    await provider.propose(samplePrompt());
    expect(log[0]!.headers["Authorization"]).toBe(wantHeader);
  });
});

// --- proposal mapping -------------------------------------------------------

describe("OpenAIProvider.propose: maps every proposal kind", () => {
  const prompt = samplePrompt();
  it.each([
    ["send-text", `{"kind":"send-text","text":"milk, eggs, bread","action_id":"","rationale":"r1"}`, { kind: "send-text", text: "milk, eggs, bread", rationale: "r1" }],
    ["click", `{"kind":"click","text":"","action_id":"btn-cancel","rationale":"r2"}`, { kind: "click", actionId: "btn-cancel", observationSequence: 2, rationale: "r2" }],
    ["task-done", `{"kind":"task-done","text":"","action_id":"","rationale":"r3"}`, { kind: "task-done", rationale: "r3" }],
    ["give-up", `{"kind":"give-up","text":"","action_id":"","rationale":"r4"}`, { kind: "give-up", rationale: "r4" }],
  ] as const)("%s", async (_name, reply, want) => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: success("fake-model", reply, 1, 1) }));
    const { proposal } = await newProvider(fetchImpl).propose(prompt);
    expect(proposal).toEqual(want);
  });

  it("repairs a reply that wraps the JSON object in prose/markdown", async () => {
    const wrapped = "Sure, here is my choice:\n```json\n" + `{"kind":"give-up","text":"","action_id":"","rationale":"stuck in a menu loop"}` + "\n```\nHope that helps!";
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: success("fake-model", wrapped, 1, 1) }));
    const { proposal } = await newProvider(fetchImpl).propose(samplePrompt());
    expect(proposal).toEqual({ kind: "give-up", rationale: "stuck in a menu loop" });
  });
});

// --- never fabricate a proposal ---------------------------------------------

describe("OpenAIProvider.propose: never fabricates a proposal", () => {
  it.each([
    ["no JSON at all", "I'm not sure how to respond to that."],
    ["truncated JSON", `{"kind":"send-text","text":"partial`],
    ["missing kind", `{"text":"hello","action_id":"","rationale":"oops"}`],
    ["unknown kind", `{"kind":"do-a-barrel-roll","text":"","action_id":"","rationale":"oops"}`],
    ["click without action_id", `{"kind":"click","text":"","action_id":"","rationale":"oops"}`],
    ["send-text without text", `{"kind":"send-text","text":"","action_id":"","rationale":"oops"}`],
    ["empty rationale", `{"kind":"give-up","text":"","action_id":"","rationale":""}`],
  ])("throws InvalidResponseError with attached usage: %s", async (_name, reply) => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: success("fake-model", reply, 42, 7) }));
    await expect(newProvider(fetchImpl).propose(samplePrompt())).rejects.toBeInstanceOf(InvalidResponseError);

    // The HTTP call succeeded — only the proposal is withheld; usage survives on the error.
    try {
      await newProvider(fetchImpl).propose(samplePrompt());
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidResponseError);
      expect((err as InvalidResponseError).usage?.model).toBe("fake-model");
    }
  });

  it("names finish_reason on an empty-content (content-filter) reply", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: {
        id: "x",
        object: "chat.completion",
        model: "fake-model",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
      },
    }));
    try {
      await newProvider(fetchImpl).propose(samplePrompt());
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidResponseError);
      expect((err as InvalidResponseError).finishReason).toBe("content_filter");
    }
  });

  it.each([
    ["empty content", ""],
    ["truncated JSON mid-object", `{"kind":"send-text","text":"partial rea`],
  ])("surfaces finish_reason=length and explains truncation: %s", async (_name, content) => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: {
        id: "x",
        object: "chat.completion",
        model: "fake-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "length" }],
      },
    }));
    try {
      await newProvider(fetchImpl).propose(samplePrompt());
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidResponseError);
      const e = err as InvalidResponseError;
      expect(e.finishReason).toBe("length");
      expect(e.message).toContain("finish_reason=length");
      expect(e.message.toLowerCase()).toContain("truncat");
    }
  });
});

// --- reasoning field precedence ---------------------------------------------

describe("OpenAIProvider.propose: reasoning-field precedence", () => {
  it("extracts a valid proposal from reasoning_content when content is empty, keeping billed usage", async () => {
    const reply = `{"kind":"give-up","text":"","action_id":"","rationale":"reasoning model routed its reply into reasoning_content"}`;
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: successField("fake-model", "reasoning_content", reply, "stop") }));
    const { proposal, usage } = await newProvider(fetchImpl).propose(samplePrompt());
    expect(proposal).toEqual({ kind: "give-up", rationale: "reasoning model routed its reply into reasoning_content" });
    expect(usage.outputTokens).toBe(45);
  });

  it("extracts a valid proposal from the alternate reasoning field", async () => {
    const reply = `{"kind":"task-done","text":"","action_id":"","rationale":"criteria visibly met"}`;
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: successField("fake-model", "reasoning", reply, "stop") }));
    const { proposal } = await newProvider(fetchImpl).propose(samplePrompt());
    expect(proposal).toEqual({ kind: "task-done", rationale: "criteria visibly met" });
  });

  it.each([["reasoning_content"], ["reasoning"]])("throws a typed error naming the source field for garbage in %s", async (field) => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: successField("fake-model", field, "Let me think about this step by step... the user wants to add items.", "stop"),
    }));
    try {
      await newProvider(fetchImpl).propose(samplePrompt());
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidResponseError);
      const e = err as InvalidResponseError;
      expect(e.source).toBe(field);
      expect(e.message).toContain(field);
    }
  });

  it("prefers content over reasoning_content when both are present", async () => {
    const contentReply = `{"kind":"give-up","text":"","action_id":"","rationale":"from content"}`;
    const reasoningReply = `{"kind":"task-done","text":"","action_id":"","rationale":"from reasoning_content, must be ignored"}`;
    const { fetchImpl } = fakeFetch(() => ({
      status: 200,
      body: {
        id: "x",
        object: "chat.completion",
        model: "fake-model",
        choices: [{ index: 0, message: { role: "assistant", content: contentReply, reasoning_content: reasoningReply }, finish_reason: "stop" }],
      },
    }));
    const { proposal } = await newProvider(fetchImpl).propose(samplePrompt());
    expect(proposal).toEqual({ kind: "give-up", rationale: "from content" });
  });
});

// --- graceful degradation ---------------------------------------------------

describe("OpenAIProvider.propose: json_schema -> json_object fallback", () => {
  it("retries exactly once with json_object and the schema restated in prose", async () => {
    const { fetchImpl, log } = fakeFetch((body) => {
      const format = body.response_format as Record<string, unknown>;
      if (format.type === "json_schema") {
        return { status: 400, body: errorEnvelope("invalid_request_error", `"response_format" of type "json_schema" is not supported`) };
      }
      return { status: 200, body: success("fake-model", `{"kind":"give-up","text":"","action_id":"","rationale":"local server has no json_schema support"}`, 10, 4) };
    });
    const provider = newProvider(fetchImpl);

    const { proposal, usage } = await provider.propose(samplePrompt());
    expect(proposal).toEqual({ kind: "give-up", rationale: "local server has no json_schema support" });
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(4);

    expect(log).toHaveLength(2);
    expect((log[0]!.body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect((log[1]!.body.response_format as Record<string, unknown>).type).toBe("json_object");
    const secondSystem = (log[1]!.body.messages as { role: string; content: string }[])[0]!.content;
    expect(secondSystem).toContain(`"kind": "send-text|click|task-done|give-up"`);
    expect(provider.lastResponseFormatMode()).toBe("json_object_fallback");
  });

  it("treats an unknown 500 rejection the same as a 400 (still falls back)", async () => {
    const { fetchImpl, log } = fakeFetch((body) => {
      const format = body.response_format as Record<string, unknown>;
      if (format.type === "json_schema") {
        return { status: 500, body: errorEnvelope("server_error", "unsupported request") };
      }
      return { status: 200, body: success("fake-model", `{"kind":"task-done","text":"","action_id":"","rationale":"recovered via fallback"}`, 5, 2) };
    });
    const provider = newProvider(fetchImpl);
    const { proposal } = await provider.propose(samplePrompt());
    expect(proposal).toEqual({ kind: "task-done", rationale: "recovered via fallback" });
    expect(log).toHaveLength(2);
    expect(provider.lastResponseFormatMode()).toBe("json_object_fallback");
  });

  it.each([
    [401, AuthenticationError],
    [403, AuthenticationError],
    [429, RateLimitError],
  ] as const)("does NOT fall back on a %s (no response_format retry)", async (status, ErrorClass) => {
    const { fetchImpl, log } = fakeFetch(() => ({ status, body: errorEnvelope("auth", "nope") }));
    const provider = newProvider(fetchImpl);
    await expect(provider.propose(samplePrompt())).rejects.toBeInstanceOf(ErrorClass);
    expect(log).toHaveLength(1); // exactly one request, never a fallback
  });
});

// --- prompt rendering snapshots ---------------------------------------------

describe("OpenAIProvider: rendered prompt", () => {
  it("renders a stable system and user prompt", async () => {
    let captured: { role: string; content: string }[] = [];
    const { fetchImpl } = fakeFetch((body) => {
      captured = body.messages as { role: string; content: string }[];
      return { status: 200, body: success("fake-model", `{"kind":"task-done","text":"","action_id":"","rationale":"done"}`, 1, 1) };
    });
    await newProvider(fetchImpl).propose(samplePrompt());
    expect(captured[0]!.content).toMatchSnapshot("system-prompt");
    expect(captured[1]!.content).toMatchSnapshot("user-prompt");
  });
});

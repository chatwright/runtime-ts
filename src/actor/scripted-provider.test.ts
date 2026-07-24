import { describe, expect, it } from "vitest";

import { ScriptedProvider, ScriptExhaustedError } from "./scripted-provider.js";
import type { Prompt, Proposal, Usage } from "./provider.js";

const usage: Usage = { model: "scripted", inputTokens: 0, outputTokens: 0, latencyMs: 0 };

function barePrompt(taskId: string): Prompt {
  return {
    goalId: "g",
    goalTitle: "t",
    taskId,
    observation: { sequence: 1, previousSequence: 0, chat: { chatId: 1 }, messages: [], changes: [] },
    history: [],
  };
}

describe("ScriptedProvider", () => {
  it("returns each scripted proposal in order, ignoring the prompt, with verbatim usage", async () => {
    const script: Proposal[] = [
      { kind: "send-text", text: "hello", rationale: "first" },
      { kind: "task-done", rationale: "second" },
    ];
    const provider = new ScriptedProvider(usage, ...script);

    const first = await provider.propose(barePrompt("t1"));
    expect(first.proposal).toEqual(script[0]);
    expect(first.usage).toEqual(usage);

    const second = await provider.propose(barePrompt("t2"));
    expect(second.proposal).toEqual(script[1]);
  });

  it("throws ScriptExhaustedError once the script runs out, naming the task", async () => {
    const provider = new ScriptedProvider(usage, { kind: "give-up", rationale: "only one" });
    await provider.propose(barePrompt("t1"));
    await expect(provider.propose(barePrompt("later-task"))).rejects.toBeInstanceOf(ScriptExhaustedError);
    await expect(provider.propose(barePrompt("later-task"))).rejects.toThrow("later-task");
  });
});

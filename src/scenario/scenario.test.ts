import { describe, expect, it } from "vitest";

import {
  parseScenarioManifest,
  ScenarioRegistry,
  SCENARIO_MANIFEST_FORMAT,
  type ManifestParseResult,
} from "./scenario.js";
import { GREETBOT_SCENARIO } from "./greetbot.js";

function errorsOf(result: ManifestParseResult): string[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

const validManifest = {
  format: SCENARIO_MANIFEST_FORMAT,
  schemaVersion: 1,
  id: "listus.add-items.manifest",
  scenario: "greetbot-language-onboarding",
  case: "default",
  mode: "ai-goal",
  inputs: { language: "en" },
  verifies: ["ac-add-items"],
};

describe("parseScenarioManifest", () => {
  it("accepts a well-formed invocation manifest", () => {
    const result = parseScenarioManifest(validManifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.scenario).toBe("greetbot-language-onboarding");
      expect(result.manifest.mode).toBe("ai-goal");
      expect(result.manifest.inputs).toEqual({ language: "en" });
    }
  });

  it("rejects an unsupported schema version EXPLICITLY, retaining the original document", () => {
    const result = parseScenarioManifest({ ...validManifest, schemaVersion: 99 });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("unsupported-schema-version");
    if (!result.ok) expect(result.document).toMatchObject({ schemaVersion: 99 });
  });

  it("rejects an unsupported capability EXPLICITLY", () => {
    const result = parseScenarioManifest({ ...validManifest, requiresCapabilities: ["ai-goal", "time-travel"] });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain("unsupported-capability");
  });

  it("rejects missing required fields and an invalid mode", () => {
    expect(errorsOf(parseScenarioManifest({ format: SCENARIO_MANIFEST_FORMAT, schemaVersion: 1 }))).toEqual(
      expect.arrayContaining(["missing-id", "missing-scenario"]),
    );
    expect(errorsOf(parseScenarioManifest({ ...validManifest, mode: "teleport" }))).toContain("invalid-mode");
    expect(errorsOf(parseScenarioManifest("not an object"))).toContain("not-an-object");
  });

  it("rejects an unknown format", () => {
    expect(errorsOf(parseScenarioManifest({ ...validManifest, format: "https://example.com/other" }))).toContain(
      "unsupported-format",
    );
  });
});

describe("ScenarioRegistry", () => {
  it("registers, resolves and lists scenarios, and rejects duplicate ids", () => {
    const registry = new ScenarioRegistry();
    registry.register(GREETBOT_SCENARIO);
    expect(registry.has("greetbot-language-onboarding")).toBe(true);
    expect(registry.get("greetbot-language-onboarding")?.version).toBe("v1");
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.register(GREETBOT_SCENARIO)).toThrowError(/already registered/);
  });

  it("lets a runner reject a manifest whose scenario is not registered", () => {
    const registry = new ScenarioRegistry();
    registry.register(GREETBOT_SCENARIO);
    const parsed = parseScenarioManifest({ ...validManifest, scenario: "unknown-scenario" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(registry.has(parsed.manifest.scenario)).toBe(false);
  });
});

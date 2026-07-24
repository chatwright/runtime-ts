/**
 * Portable scenario documents: a versioned, serialisable invocation manifest
 * that names a registered Chatwright scenario, its inputs and its execution
 * mode — the first document model the portable-scenario-documents feature
 * describes.
 *
 * @remarks
 * Parsing NEVER starts a bot, opens a database, expands secrets or executes
 * scenario actions (feature AC `unsupported-schema-is-safe`): it only
 * validates structure and reports, EXPLICITLY, an unsupported schema version
 * or capability rather than silently dropping it. A {@link ScenarioRegistry}
 * resolves a manifest's `scenario` id to a {@link RegisteredScenario}; the
 * runner (see `src/run`) executes the resolved scenario's parts.
 */

/** The manifest format identifier this runner understands. */
export const SCENARIO_MANIFEST_FORMAT = "https://chatwright.dev/formats/scenario-manifest/v1";

/** The manifest schema version this runner supports. */
export const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

/** The execution-mode capabilities this runner supports (a manifest requiring anything else is rejected). */
export const SUPPORTED_CAPABILITIES = ["deterministic", "ai-goal", "hybrid"] as const;

/** A manifest's declared execution mode. */
export type ScenarioMode = (typeof SUPPORTED_CAPABILITIES)[number];

/** A versioned, serialisable invocation manifest. */
export interface ScenarioManifest {
  readonly format: string;
  readonly schemaVersion: number;
  /** This manifest's own stable logical id. */
  readonly id: string;
  /** The manifest's source URL, when known (provenance). */
  readonly source?: string;
  /** The registered scenario this manifest invokes. */
  readonly scenario: string;
  /** The selected named case, when the scenario exposes several. */
  readonly case?: string;
  readonly mode?: ScenarioMode;
  /** Declared inputs passed to the registered scenario. */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** Capabilities the runner must support to run this manifest. */
  readonly requiresCapabilities?: readonly string[];
  /** Descriptive acceptance-criterion references — non-executable binding metadata. */
  readonly verifies?: readonly string[];
}

/** One validation problem found while parsing a manifest. */
export interface ManifestError {
  /** A stable, machine-readable code (e.g. `"unsupported-schema-version"`). */
  readonly code: string;
  readonly message: string;
}

/**
 * The result of {@link parseScenarioManifest}. On failure the ORIGINAL
 * document is retained (never discarded), per the feature's
 * `unsupported-schema-is-safe` acceptance criterion.
 */
export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: ScenarioManifest }
  | { readonly ok: false; readonly errors: readonly ManifestError[]; readonly document: unknown };

/**
 * Validates `document` as a scenario manifest — structurally only, with no
 * side effects. Reports unsupported schema versions and capabilities,
 * undeclared required fields and invalid mode selections EXPLICITLY. Never
 * starts a bot, opens a database or resolves a secret.
 */
export function parseScenarioManifest(document: unknown): ManifestParseResult {
  const errors: ManifestError[] = [];
  const fail = (code: string, message: string) => errors.push({ code, message });

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, errors: [{ code: "not-an-object", message: "manifest must be a JSON object" }], document };
  }
  const doc = document as Record<string, unknown>;

  if (typeof doc.format !== "string" || doc.format === "") {
    fail("missing-format", "manifest.format must be a non-empty string");
  } else if (doc.format !== SCENARIO_MANIFEST_FORMAT) {
    fail("unsupported-format", `unsupported manifest format "${doc.format}"; this runner understands "${SCENARIO_MANIFEST_FORMAT}"`);
  }

  if (typeof doc.schemaVersion !== "number") {
    fail("missing-schema-version", "manifest.schemaVersion must be a number");
  } else if (doc.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    fail(
      "unsupported-schema-version",
      `unsupported manifest schemaVersion ${doc.schemaVersion}; this runner supports version ${SUPPORTED_MANIFEST_SCHEMA_VERSION}`,
    );
  }

  if (typeof doc.id !== "string" || doc.id === "") fail("missing-id", "manifest.id must be a non-empty string");
  if (typeof doc.scenario !== "string" || doc.scenario === "") {
    fail("missing-scenario", "manifest.scenario must name a registered scenario");
  }

  if (doc.mode !== undefined && !(SUPPORTED_CAPABILITIES as readonly string[]).includes(doc.mode as string)) {
    fail("invalid-mode", `invalid mode "${String(doc.mode)}"; supported: ${SUPPORTED_CAPABILITIES.join(", ")}`);
  }

  if (doc.requiresCapabilities !== undefined) {
    if (!Array.isArray(doc.requiresCapabilities)) {
      fail("invalid-capabilities", "manifest.requiresCapabilities must be an array of strings");
    } else {
      for (const capability of doc.requiresCapabilities) {
        if (!(SUPPORTED_CAPABILITIES as readonly string[]).includes(capability as string)) {
          fail("unsupported-capability", `unsupported capability "${String(capability)}"`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, document };

  return {
    ok: true,
    manifest: {
      format: doc.format as string,
      schemaVersion: doc.schemaVersion as number,
      id: doc.id as string,
      scenario: doc.scenario as string,
      ...(typeof doc.source === "string" ? { source: doc.source } : {}),
      ...(typeof doc.case === "string" ? { case: doc.case } : {}),
      ...(doc.mode !== undefined ? { mode: doc.mode as ScenarioMode } : {}),
      ...(isRecord(doc.inputs) ? { inputs: doc.inputs } : {}),
      ...(Array.isArray(doc.requiresCapabilities) ? { requiresCapabilities: doc.requiresCapabilities as string[] } : {}),
      ...(Array.isArray(doc.verifies) ? { verifies: doc.verifies as string[] } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A scenario registered in a {@link ScenarioRegistry}. It exposes only its
 * stable identity and declared capabilities/cases — enough to validate a
 * manifest reference without loading application code (the feature's
 * capability-description open question, answered minimally here). Building an
 * executable {@link "../run/run.js".Run} from it is the registered scenario's
 * own concern (see `src/scenario/greetbot.ts`).
 */
export interface RegisteredScenario {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly capabilities?: readonly string[];
  readonly cases?: readonly string[];
}

/** A registry of {@link RegisteredScenario}s a manifest's `scenario` id resolves against. */
export class ScenarioRegistry {
  readonly #scenarios = new Map<string, RegisteredScenario>();

  /** Registers `scenario`; throws if its id is already registered. */
  register(scenario: RegisteredScenario): void {
    if (this.#scenarios.has(scenario.id)) {
      throw new Error(`scenario: "${scenario.id}" is already registered`);
    }
    this.#scenarios.set(scenario.id, scenario);
  }

  /** Returns the registered scenario for `id`, or `undefined`. */
  get(id: string): RegisteredScenario | undefined {
    return this.#scenarios.get(id);
  }

  /** Whether `id` is registered. */
  has(id: string): boolean {
    return this.#scenarios.has(id);
  }

  /** Every registered scenario, in registration order. */
  list(): RegisteredScenario[] {
    return [...this.#scenarios.values()];
  }
}

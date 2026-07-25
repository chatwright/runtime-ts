/**
 * Machine-readable validation findings for the scenario-document parser —
 * ported from `runtime-go`'s `scenario/report.go`. A rejection names the
 * JSON pointer and the rule id and never echoes the offending value (the
 * format README's own rule); {@link Issue.message} is written by this
 * package's own code at each call site, never built by interpolating a
 * document-supplied value, so that requirement holds by construction rather
 * than by scrubbing after the fact.
 */

/** Classifies one {@link Issue}. */
export type Severity = "error" | "warning";

/**
 * One machine-readable validation finding: a rule id, the JSON pointer into
 * the document it applies to (RFC 6901; `""` for a document-level issue with
 * no single location), a human-readable message that never echoes the
 * offending value, and a {@link Severity}.
 */
export interface Issue {
  /** A short, stable, machine-readable rule id, e.g. `"inline-secret"`, `"unsupported-capability"`, `"ai-goal-budgets-required"`. */
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
  readonly severity: Severity;
}

/** Every {@link Issue} `parseScenarioDocument` found, in the order they were discovered. */
export interface Report {
  readonly issues: readonly Issue[];
}

/** Builds a `SeverityError` {@link Issue}. */
export function errorIssue(code: string, pointer: string, message: string): Issue {
  return { code, pointer, message, severity: "error" };
}

/** Builds a `SeverityWarning` {@link Issue}. */
export function warningIssue(code: string, pointer: string, message: string): Issue {
  return { code, pointer, message, severity: "warning" };
}

/** Every `SeverityError` issue in `report`, in order. */
export function reportErrors(report: Report): Issue[] {
  return report.issues.filter((i) => i.severity === "error");
}

/** Every `SeverityWarning` issue in `report`, in order. */
export function reportWarnings(report: Report): Issue[] {
  return report.issues.filter((i) => i.severity === "warning");
}

/** Reports whether `report` carries at least one `SeverityError` issue — exactly the condition under which parsing rejects the whole document. */
export function reportHasErrors(report: Report): boolean {
  return report.issues.some((i) => i.severity === "error");
}

/**
 * A mutable issue accumulator used while parsing/validating one document.
 * Callers read it back as a {@link Report} via {@link ReportBuilder.build}.
 */
export class ReportBuilder {
  private readonly issues: Issue[] = [];

  add(issue: Issue): void {
    this.issues.push(issue);
  }

  error(code: string, pointer: string, message: string): void {
    this.add(errorIssue(code, pointer, message));
  }

  warning(code: string, pointer: string, message: string): void {
    this.add(warningIssue(code, pointer, message));
  }

  hasErrors(): boolean {
    return this.issues.some((i) => i.severity === "error");
  }

  build(): Report {
    return { issues: [...this.issues] };
  }
}

/**
 * The error thrown (returned as `RejectionError` in Go) for a {@link Report}
 * with at least one `SeverityError` issue. `message` renders every
 * error-severity issue as `"<pointer>: <code>: <message>"`, one per line —
 * never the report's warnings, and never any document-supplied value.
 */
export class ScenarioRejectionError extends Error {
  readonly report: Report;

  constructor(report: Report) {
    super(renderRejection(report));
    this.name = "ScenarioRejectionError";
    this.report = report;
  }
}

function renderRejection(report: Report): string {
  const lines = reportErrors(report).map((issue) => `${issue.pointer === "" ? "(document)" : issue.pointer}: ${issue.code}: ${issue.message}`);
  return "scenario: document rejected:\n" + lines.join("\n");
}

/** Returns a {@link ScenarioRejectionError} wrapping `report` when it has errors, `undefined` otherwise. */
export function reportAsError(report: Report): ScenarioRejectionError | undefined {
  return reportHasErrors(report) ? new ScenarioRejectionError(report) : undefined;
}

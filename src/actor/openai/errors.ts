/**
 * The `actor/openai` error taxonomy, ported from the Go runtime's
 * `actor/openai/errors.go`.
 */

import type { Usage } from "../provider.js";

/**
 * Wraps an OpenAI-compatible server's 401/403 response: the API key is
 * missing, invalid, revoked, or lacks access to the requested model. Never
 * retryable without fixing the key — `propose` does not attempt the
 * json_object fallback for this status (a rejected key is not a
 * response_format rejection).
 */
export class AuthenticationError extends Error {
  constructor(override readonly cause: Error) {
    super(`actor/openai: authentication failed: ${cause.message}`);
    this.name = "AuthenticationError";
  }
}

/**
 * Wraps an OpenAI-compatible server's 429 response. Retryable after backoff;
 * this package does not retry internally. Not eligible for the json_object
 * fallback either: a rate limit is not a response_format rejection.
 */
export class RateLimitError extends Error {
  constructor(override readonly cause: Error) {
    super(`actor/openai: rate limited: ${cause.message}`);
    this.name = "RateLimitError";
  }
}

const MAX_RAW_IN_ERROR = 200;

/**
 * Means the model's reply could not be turned into a valid
 * {@link "../provider.js".Proposal}: malformed JSON even after the one repair
 * attempt, a JSON object that does not match the response contract, or a
 * response with no usable text in any field at all. `propose` never fabricates
 * a proposal in its place.
 */
export class InvalidResponseError extends Error {
  /** The model's raw reply text that failed to parse, or empty if the response carried no usable text in any field. */
  readonly raw: string;
  /** The response's first choice's `finish_reason`, when known (e.g. `"length"` or `"content_filter"`). */
  readonly finishReason: string;
  /** Which response field `raw` was read from — `"content"`, `"reasoning_content"` or `"reasoning"` — or empty. */
  readonly source: string;
  override readonly cause: Error;
  /**
   * The {@link "../provider.js".Usage} the (successful) HTTP call reported, if
   * any — preserved here because, unlike the Go runtime's `(Proposal, Usage,
   * error)` triple, a thrown error cannot return usage alongside it.
   */
  readonly usage?: Usage;

  constructor(fields: {
    raw?: string;
    finishReason?: string;
    source?: string;
    cause: Error;
    usage?: Usage;
  }) {
    super(InvalidResponseError.#format(fields));
    this.name = "InvalidResponseError";
    this.raw = fields.raw ?? "";
    this.finishReason = fields.finishReason ?? "";
    this.source = fields.source ?? "";
    this.cause = fields.cause;
    this.usage = fields.usage;
  }

  static #format(fields: { raw?: string; finishReason?: string; source?: string; cause: Error }): string {
    let raw = fields.raw ?? "";
    if (raw.length > MAX_RAW_IN_ERROR) raw = raw.slice(0, MAX_RAW_IN_ERROR) + "…";

    const tags: string[] = [];
    switch (fields.finishReason ?? "") {
      case "":
        break;
      case "length":
        tags.push("finish_reason=length, reply likely truncated before max_tokens was reached");
        break;
      default:
        tags.push(`finish_reason=${fields.finishReason}`);
        break;
    }
    const source = fields.source ?? "";
    if (source !== "" && source !== "content") tags.push(`source=${source}`);

    const quotedRaw = JSON.stringify(raw);
    if (tags.length > 0) {
      return `actor/openai: invalid response (${tags.join(", ")}): ${fields.cause.message} (raw: ${quotedRaw})`;
    }
    return `actor/openai: invalid response: ${fields.cause.message} (raw: ${quotedRaw})`;
  }
}

/**
 * Means the primary json_schema request failed in a way classified as
 * retryable, and the one-shot json_object fallback attempt also failed at the
 * HTTP/transport level. Both underlying errors are retained; neither attempt
 * is retried further.
 */
export class FallbackFailedError extends Error {
  constructor(
    readonly jsonSchemaError: Error,
    readonly jsonObjectError: Error,
  ) {
    super(
      `actor/openai: json_schema request failed (${jsonSchemaError.message}), json_object fallback also failed: ${jsonObjectError.message}`,
    );
    this.name = "FallbackFailedError";
  }
}

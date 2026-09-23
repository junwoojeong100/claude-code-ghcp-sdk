// Claude Code backs off and retries a 429 rate_limit_error (after retry-after
// when one is sent) and a 529 overloaded_error. Upstream failures of those
// kinds carry the Anthropic status and type they leave the bridge with.
export class UpstreamError extends Error {
  constructor(message, { status, type, retryAfterSeconds = null }) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.type = type;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// session.error data (ErrorData in the SDK's generated/session-events.d.ts)
// names the category in errorType ("rate_limit", "quota", "context_limit",
// ...) and the upstream HTTP status in statusCode. It carries no retry time:
// retryAfterSeconds exists only on auto_mode_switch.requested, which the
// bridge never asks for.
const RATE_LIMIT_ERROR_TYPES = new Set(["rate_limit", "quota"]);

export function sessionError(data, { retryAfterSeconds = null } = {}) {
  const { errorType, message: upstreamMessage, statusCode } = data || {};
  const message = upstreamMessage || "GitHub Copilot SDK session error.";
  if (RATE_LIMIT_ERROR_TYPES.has(errorType) || statusCode === 429) {
    return new UpstreamError(message, {
      status: 429,
      type: "rate_limit_error",
      retryAfterSeconds,
    });
  }
  if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599) {
    return new UpstreamError(message, {
      status: 529,
      type: "overloaded_error",
      retryAfterSeconds,
    });
  }
  return new Error(message);
}

// BRIDGE_TEST_FAULTS is a verification seam; server.mjs describes it. The
// value is a comma-separated list of kind:count, e.g. "rate_limit:1,overloaded:1".
export const TEST_FAULT_KINDS = ["rate_limit", "overloaded", "context_limit"];

export function parseTestFaults(raw) {
  if (raw === undefined || raw === "") return [];
  const faults = [];
  for (const entry of raw.split(",")) {
    const match = /^([a-z_]+):([1-9]\d*)$/.exec(entry.trim());
    if (
      !match ||
      !TEST_FAULT_KINDS.includes(match[1]) ||
      !Number.isSafeInteger(Number(match[2]))
    ) {
      throw new Error(
        `BRIDGE_TEST_FAULTS entries must be kind:count with a kind of ${TEST_FAULT_KINDS.join(", ")} and a positive integer count; got ${JSON.stringify(entry)}.`,
      );
    }
    if (faults.some((fault) => fault.kind === match[1])) {
      throw new Error(`BRIDGE_TEST_FAULTS lists ${match[1]} more than once.`);
    }
    faults.push({ kind: match[1], remaining: Number(match[2]) });
  }
  return faults;
}

// Built from SDK-shaped session.error data, so an injected fault goes through
// the same classification and status mapping as a real one.
export function testFaultError(kind) {
  if (kind === "rate_limit") {
    return sessionError({
      errorType: "rate_limit",
      errorCode: "rate_limited",
      message: "BRIDGE_TEST_FAULTS injected an upstream rate limit.",
      statusCode: 429,
    }, { retryAfterSeconds: 1 });
  }
  if (kind === "overloaded") {
    return sessionError({
      errorType: "query",
      message: "BRIDGE_TEST_FAULTS injected an overloaded upstream.",
      statusCode: 503,
    });
  }
  throw new Error(`No upstream error is defined for test fault ${kind}.`);
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTestFaults,
  sessionError,
  testFaultError,
  UpstreamError,
} from "../src/upstream-errors.mjs";

test("session errors classify on errorType first and statusCode second", () => {
  const cases = [
    [{ errorType: "rate_limit", message: "limited" }, 429, "rate_limit_error"],
    [{ errorType: "quota", errorCode: "session_quota_exceeded", message: "spent" }, 429, "rate_limit_error"],
    [{ errorType: "query", statusCode: 429, message: "too many" }, 429, "rate_limit_error"],
    [{ errorType: "query", statusCode: 500, message: "boom" }, 529, "overloaded_error"],
    [{ errorType: "query", statusCode: 599, message: "boom" }, 529, "overloaded_error"],
  ];
  for (const [data, status, type] of cases) {
    const error = sessionError(data);
    assert.ok(error instanceof UpstreamError, JSON.stringify(data));
    assert.deepEqual([error.status, error.type, error.message], [status, type, data.message]);
  }
  for (const data of [
    { errorType: "context_limit", message: "too long", statusCode: 400 },
    { errorType: "authentication", message: "sign in", statusCode: 401 },
    { errorType: "query", message: "odd", statusCode: 600 },
  ]) {
    const error = sessionError(data);
    assert.equal(error instanceof UpstreamError, false, JSON.stringify(data));
    assert.equal(error.message, data.message);
  }
  assert.equal(sessionError(undefined).message, "GitHub Copilot SDK session error.");
  assert.equal(sessionError({ errorType: "rate_limit" }, { retryAfterSeconds: 30 }).retryAfterSeconds, 30);
});

test("BRIDGE_TEST_FAULTS parses kind:count entries in order", () => {
  assert.deepEqual(parseTestFaults(undefined), []);
  assert.deepEqual(parseTestFaults(""), []);
  assert.deepEqual(parseTestFaults(" overloaded:2 , rate_limit:1,context_limit:3"), [
    { kind: "overloaded", remaining: 2 },
    { kind: "rate_limit", remaining: 1 },
    { kind: "context_limit", remaining: 3 },
  ]);
  for (const value of [
    "rate_limit", "rate_limit:", "rate_limit:0", "rate_limit:-1", "rate_limit:1.5",
    "rate_limit:01", "timeout:1", "RATE_LIMIT:1", "rate_limit:1,", ",", "rate_limit:99999999999999999",
  ]) {
    assert.throws(() => parseTestFaults(value), /BRIDGE_TEST_FAULTS entries must be kind:count/, value);
  }
  assert.throws(() => parseTestFaults("overloaded:1,overloaded:1"), /lists overloaded more than once/);
});

test("injected upstream faults carry the mapped status, type and retry time", () => {
  const rateLimit = testFaultError("rate_limit");
  assert.deepEqual([rateLimit.status, rateLimit.type, rateLimit.retryAfterSeconds], [429, "rate_limit_error", 1]);
  const overloaded = testFaultError("overloaded");
  assert.deepEqual([overloaded.status, overloaded.type, overloaded.retryAfterSeconds], [529, "overloaded_error", null]);
  // context_limit comes from the session manager, which knows the token limit.
  assert.throws(() => testFaultError("context_limit"), /No upstream error is defined/);
});

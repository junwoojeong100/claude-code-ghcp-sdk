/** Offline limits: one total budget per scenario plus bounded cleanup. */
import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS } from "../scripts/verify/scenarios.mjs";
import { parseArgs } from "../scripts/verify/run.mjs";
import {
  DEFAULT_TIMEOUTS, MAX_TIMEOUT_MS, createTimeoutPolicy,
  parseTimeoutScale, readPendingToolWaitMs, runtimeTimeouts, scaleTimeoutMs,
} from "../scripts/verify/timeouts.mjs";

const policy = (scale) => ({
  scale, bridgeHealthMs: Math.ceil(120000 * scale), cleanupMs: Math.ceil(10000 * scale),
  interrupt: { progressMs: Math.ceil(90000 * scale), settleMs: Math.ceil(15000 * scale), recoveryMs: Math.ceil(60000 * scale) },
  scenarioMs: Object.fromEntries(SCENARIOS.map(s => [s.id, Math.ceil(s.budgetSeconds * 1000 * scale)])),
});

test("six total slot budgets and bounded cleanup scale without changing defaults", () => {
  assert.equal(MAX_TIMEOUT_MS, 2147483647);
  assert.deepEqual(DEFAULT_TIMEOUTS, { bridgeHealthMs: 120000, cleanupMs: 10000 });
  assert.deepEqual(SCENARIOS.map(s => s.budgetSeconds), [240, 300, 240, 240, 240, 420]);
  const before = structuredClone(SCENARIOS);
  for (const scale of [1, 2, 0.5, 1.000001]) assert.deepEqual(createTimeoutPolicy(SCENARIOS, scale), policy(scale));
  assert.deepEqual(createTimeoutPolicy(SCENARIOS), policy(1));
  assert.deepEqual(createTimeoutPolicy(SCENARIOS, "2"), policy(2));
  assert.deepEqual(SCENARIOS, before);
  assert.ok(Object.isFrozen(createTimeoutPolicy(SCENARIOS).scenarioMs));
  assert.ok(Object.isFrozen(createTimeoutPolicy(SCENARIOS).interrupt));
  const timeouts = createTimeoutPolicy(SCENARIOS);
  assert.equal(timeouts.scenarioMs.V05, 240000);
  assert.ok(Object.values(timeouts.interrupt).reduce((n, ms) => n + ms, timeouts.cleanupMs) < timeouts.scenarioMs.V05);
});

test("scale accepts positive finite numbers and rejects malformed explicit values", () => {
  for (const [raw, expected] of [[1, 1], [0.5, 0.5], ["2", 2], [" 1.25 ", 1.25], ["1e2", 100]]) {
    assert.equal(parseTimeoutScale(raw), expected);
  }
  for (const raw of [undefined, null, "", " \t", "nope", "2ms", "--dry-run", 0, -1, "0", "-2", NaN, Infinity, -Infinity, "NaN", "Infinity", "1e309", true, {}, []]) {
    assert.throws(() => parseTimeoutScale(raw), /--timeout-scale must be a positive finite number/, String(raw));
  }
  assert.throws(() => parseArgs(["--timeout-scale"]), /--timeout-scale/);
});

test("scaled delays round up and never wrap the Node timer", () => {
  assert.equal(scaleTimeoutMs(1001, 1.5), 1502);
  assert.equal(scaleTimeoutMs(1501, 0.5), 751);
  assert.equal(scaleTimeoutMs(1, 0.01), 1);
  assert.equal(scaleTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
  for (const base of [0, -1, NaN, Infinity, MAX_TIMEOUT_MS + 1]) {
    assert.throws(() => scaleTimeoutMs(base), /delay outside/);
  }
  assert.throws(() => scaleTimeoutMs(MAX_TIMEOUT_MS, 2), /delay outside/);
  assert.throws(() => createTimeoutPolicy(SCENARIOS, 1e300), /delay outside/);
  assert.ok(120000 * 8000 < MAX_TIMEOUT_MS);
  assert.throws(() => createTimeoutPolicy(SCENARIOS, 8000), /delay outside/);
});

test("pending-tool runtime override is validated but never scaled or overwritten", () => {
  assert.equal(readPendingToolWaitMs({}), 10000);
  assert.equal(readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: "" }), 10000);
  for (const value of [1, 30000, MAX_TIMEOUT_MS]) assert.equal(readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: String(value) }), value);
  const env = Object.freeze({ PENDING_TOOL_WAIT_MS: "30000" });
  createTimeoutPolicy(SCENARIOS, 2);
  assert.equal(readPendingToolWaitMs(env), 30000);
  for (const raw of [" ", "0", "-1", "1.5", "30000ms", "NaN", "Infinity", "1e309", String(MAX_TIMEOUT_MS + 1)]) {
    assert.throws(() => readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: raw }), /PENDING_TOOL_WAIT_MS must be an integer/);
  }
});

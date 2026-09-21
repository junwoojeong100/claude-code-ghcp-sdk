/** Offline timeout-policy and dry-run guards. Never enter the live verification path. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_PLAN, PRIMARY_MODELS, SCENARIOS, gateFor, planRun } from "../scripts/verify/scenarios.mjs";
import {
  DEFAULT_TIMEOUTS,
  MAX_TIMEOUT_MS,
  createTimeoutPolicy,
  parseTimeoutScale,
  readPendingToolWaitMs,
  scaleTimeoutMs,
} from "../scripts/verify/timeouts.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/verify/run.mjs", import.meta.url));
const BASE_TIMEOUTS = {
  bridgeHealthMs: 120000,
  planTurnMs: 90000,
  backgroundLaunchMs: 120000,
  foregroundLaunchMs: 180000,
  persistentLaunchMs: 120000,
  detachedOutputMs: 240000,
};
const BASE_SCENARIO_SECONDS = {
  "v01-repo-recon": 240,
  "v02-surgical-edit": 240,
  "v03-test-fix-loop": 240,
  "v04-shell-ops": 420,
  "v05-multi-step": 300,
  "v06-subagent": 240,
  "v07-mcp-playwright": 300,
  "v08-hooks-memory": 330,
  "v09-session-resume": 300,
  "v10-long-context": 240,
  "v11-daemon-background": 420,
};

function expectedPolicy(scale) {
  return {
    scale,
    ...Object.fromEntries(Object.entries(BASE_TIMEOUTS).map(([key, ms]) => [key, Math.ceil(ms * scale)])),
    scenarioMs: Object.fromEntries(
      Object.entries(BASE_SCENARIO_SECONDS).map(([id, seconds]) => [id, Math.ceil(seconds * 1000 * scale)]),
    ),
  };
}

function dryRun(t, args = [], pendingToolWaitMs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-timeouts-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const outDir = path.join(cwd, "runs");
  const env = { ...process.env };
  delete env.PENDING_TOOL_WAIT_MS;
  if (pendingToolWaitMs !== undefined) env.PENDING_TOOL_WAIT_MS = pendingToolWaitMs;
  // Even invalid-argument cases carry --dry-run first: none may enter a live path.
  const result = spawnSync(process.execPath, [RUNNER, "--dry-run", "--out", outDir, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `dry-run terminated by ${result.signal}`);
  assert.equal(fs.existsSync(outDir), false, "dry-run must not create an output run directory");
  assert.deepEqual(fs.readdirSync(cwd), [], "dry-run must leave its working directory untouched");
  return result;
}

test("omitted timeout scale preserves every independent and scenario default", () => {
  assert.equal(MAX_TIMEOUT_MS, 2147483647);
  assert.deepEqual(DEFAULT_TIMEOUTS, BASE_TIMEOUTS);
  assert.deepEqual(createTimeoutPolicy(SCENARIOS), expectedPolicy(1));
  assert.deepEqual(createTimeoutPolicy(SCENARIOS, 1), createTimeoutPolicy(SCENARIOS));
  assert.equal(scaleTimeoutMs(90000), 90000);
});

test("scale 2 doubles independent and scenario limits without mutating their defaults", () => {
  const catalogBefore = structuredClone(SCENARIOS);
  const policy = createTimeoutPolicy(SCENARIOS, 2);
  assert.deepEqual(policy, expectedPolicy(2));
  assert.deepEqual({
    bridgeHealthMs: policy.bridgeHealthMs,
    planTurnMs: policy.planTurnMs,
    backgroundLaunchMs: policy.backgroundLaunchMs,
    foregroundLaunchMs: policy.foregroundLaunchMs,
    persistentLaunchMs: policy.persistentLaunchMs,
    detachedOutputMs: policy.detachedOutputMs,
  }, {
    bridgeHealthMs: 240000,
    planTurnMs: 180000,
    backgroundLaunchMs: 240000,
    foregroundLaunchMs: 360000,
    persistentLaunchMs: 240000,
    detachedOutputMs: 480000,
  });
  // v11's catalogue entry is planning only, not a replacement for its step waits.
  assert.equal(policy.scenarioMs["v11-daemon-background"], 840000);
  assert.notEqual(policy.detachedOutputMs, policy.scenarioMs["v11-daemon-background"]);
  assert.deepEqual(DEFAULT_TIMEOUTS, BASE_TIMEOUTS);
  assert.deepEqual(SCENARIOS, catalogBefore);
  assert.deepEqual(createTimeoutPolicy(SCENARIOS), expectedPolicy(1));
});

test("timeout scales accept positive finite numbers and numeric strings", () => {
  for (const [raw, expected] of [[1, 1], [2, 2], [0.5, 0.5], ["2", 2], [" 1.25 ", 1.25], ["1e2", 100]]) {
    assert.equal(parseTimeoutScale(raw), expected);
  }
  assert.deepEqual(createTimeoutPolicy(SCENARIOS, "2"), expectedPolicy(2));
});

test("missing and malformed timeout scales fail rather than selecting a default", () => {
  for (const raw of [undefined, null, "", " \t", "nope", "2ms", "--dry-run", 0, -1, "0", "-2", NaN, Infinity, -Infinity, "NaN", "Infinity", "1e309", true, {}, []]) {
    assert.throws(() => parseTimeoutScale(raw), /--timeout-scale must be a positive finite number/, String(raw));
  }
});

test("scaled waits round up once and reject values outside the timer range", () => {
  assert.equal(scaleTimeoutMs(1001, 1.5), 1502);
  assert.equal(scaleTimeoutMs(1501, 0.5), 751);
  assert.equal(scaleTimeoutMs(1, 0.01), 1);
  assert.equal(scaleTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const rounded = createTimeoutPolicy(SCENARIOS, 1.000001);
  assert.equal(rounded.planTurnMs, 90001);
  assert.equal(rounded.scenarioMs["v01-repo-recon"], 240001);

  const outsideRange = /--timeout-scale produces a delay outside/;
  for (const base of [0, -1, NaN, Infinity, MAX_TIMEOUT_MS + 1]) {
    assert.throws(() => scaleTimeoutMs(base), outsideRange);
  }
  assert.throws(() => scaleTimeoutMs(MAX_TIMEOUT_MS, 2), outsideRange);
  assert.throws(() => scaleTimeoutMs(240000, 1e300), outsideRange);
  assert.throws(() => createTimeoutPolicy(SCENARIOS, 10000), outsideRange);
  // All independent waits still fit at 6000x; the 420s scenario budgets do not.
  assert.ok(240000 * 6000 < MAX_TIMEOUT_MS);
  assert.throws(() => createTimeoutPolicy(SCENARIOS, 6000), outsideRange);
  assert.throws(() => planRun({ timeoutScale: 6000 }), outsideRange);
});

test("pending-tool wait retains its separate default and validates explicit overrides", () => {
  assert.equal(readPendingToolWaitMs({}), 10000);
  assert.equal(readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: "" }), 10000);
  for (const value of [1, 30000, MAX_TIMEOUT_MS]) {
    assert.equal(readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: String(value) }), value);
  }
  const env = Object.freeze({ PENDING_TOOL_WAIT_MS: "30000" });
  createTimeoutPolicy(SCENARIOS, 2);
  assert.equal(readPendingToolWaitMs(env), 30000);
  assert.deepEqual(env, { PENDING_TOOL_WAIT_MS: "30000" });
  for (const raw of [" ", "0", "-1", "1.5", "30000ms", "NaN", "Infinity", "1e309", String(MAX_TIMEOUT_MS + 1)]) {
    assert.throws(() => readPendingToolWaitMs({ PENDING_TOOL_WAIT_MS: raw }), /PENDING_TOOL_WAIT_MS must be an integer/, raw);
  }
});

test("scaling preserves the catalogue, 77 unique slots, gate 77 and default concurrency", () => {
  const catalogBefore = structuredClone(SCENARIOS);
  assert.deepEqual(Object.fromEntries(SCENARIOS.map((s) => [s.id, s.budgetSeconds])), BASE_SCENARIO_SECONDS);
  assert.deepEqual(PRIMARY_MODELS, [
    "claude-opus-5", "claude-sonnet-5", "claude-haiku-4.5",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra",
  ]);
  const slots = PRIMARY_MODELS.flatMap((model) => SCENARIOS.map((s) => `${model}::${s.id}`));
  assert.equal(slots.length, 77);
  assert.equal(new Set(slots).size, 77);
  assert.equal(gateFor(slots.length), 77);
  assert.deepEqual(DEFAULT_PLAN, { modelConcurrency: 7, scenarioConcurrency: 2, overheadSeconds: 180 });

  const normal = planRun();
  const doubled = planRun({ timeoutScale: 2 });
  assert.equal(normal.wallClockSeconds, 1815);
  assert.equal(doubled.wallClockSeconds, 3450);
  assert.deepEqual(normal.perModel, { serialSeconds: 3270, criticalPathSeconds: 1635 });
  assert.deepEqual(doubled.perModel, { serialSeconds: 6540, criticalPathSeconds: 3270 });
  for (const plan of [normal, doubled]) {
    assert.equal(plan.slots, 77);
    assert.equal(plan.models, 7);
    assert.equal(plan.scenarios, 11);
    assert.equal(plan.modelConcurrency, 7);
    assert.equal(plan.scenarioConcurrency, 2);
    assert.equal(plan.waves, 1);
    assert.equal(plan.peakClaudeProcesses, 14);
    assert.equal(plan.withinLimit, true);
  }
  assert.equal(doubled.wallClockSeconds - doubled.perModel.criticalPathSeconds, 180);
  assert.deepEqual(SCENARIOS, catalogBefore);
});

test("CLI dry-run records exact execution settings without creating run artifacts", (t) => {
  for (const entry of [
    { args: [], scale: 1, pending: undefined, modelConcurrency: 7, scenarioConcurrency: 2 },
    { args: ["--timeout-scale", "2"], scale: 2, pending: "30000", modelConcurrency: 7, scenarioConcurrency: 2 },
    {
      args: ["--timeout-scale", "0.5", "--model-concurrency", "3", "--scenario-concurrency", "1"],
      scale: 0.5, pending: "30000", modelConcurrency: 3, scenarioConcurrency: 1,
    },
  ]) {
    const result = dryRun(t, entry.args, entry.pending);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n").filter((line) => line.startsWith("execution: "));
    assert.equal(lines.length, 1, "one execution JSON record must be printed");
    assert.deepEqual(JSON.parse(lines[0].slice("execution: ".length)), {
      modelConcurrency: entry.modelConcurrency,
      scenarioConcurrency: entry.scenarioConcurrency,
      pendingToolWaitMs: entry.pending === undefined ? 10000 : Number(entry.pending),
      timeouts: expectedPolicy(entry.scale),
    });
    assert.match(result.stdout, /^slots:\s+77$/m);
    assert.match(result.stdout, /--dry-run: no calls made/);
    assert.match(result.stdout, /not a deadline or worst-case bound/);
    if (entry.scale === 1 || entry.scale === 2) {
      const minutes = entry.scale === 1 ? 30 : 58;
      assert.ok(result.stdout.includes(`single-turn scheduling estimate ~${minutes} min, peak 14 Claude processes`));
    }
  }
});

test("CLI rejects missing, malformed and overflowing scales before creating artifacts", (t) => {
  for (const args of [
    ["--timeout-scale"],
    ["--timeout-scale", ""],
    ["--timeout-scale", "nope"],
    ["--timeout-scale", "0"],
    ["--timeout-scale", "-1"],
    ["--timeout-scale", "Infinity"],
    ["--timeout-scale", "1e309"],
    ["--timeout-scale", "6000"],
  ]) {
    const result = dryRun(t, args);
    assert.notEqual(result.status, 0, `accepted invalid arguments: ${JSON.stringify(args)}`);
    assert.match(result.stderr, /--timeout-scale (?:must be a positive finite number|produces a delay outside)/);
    assert.doesNotMatch(result.stdout, /^execution: /m);
  }
});

test("CLI rejects invalid pending-tool waits before creating artifacts", (t) => {
  for (const pending of ["0", "1.5", "nope", String(MAX_TIMEOUT_MS + 1)]) {
    const result = dryRun(t, ["--timeout-scale", "2"], pending);
    assert.notEqual(result.status, 0, `accepted invalid pending-tool wait: ${pending}`);
    assert.match(result.stderr, /PENDING_TOOL_WAIT_MS must be an integer/);
    assert.doesNotMatch(result.stdout, /^execution: /m);
  }
});

/** Offline runner guards and completion fixtures. No test launches Claude or a provider. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRIMARY_MODELS, SCENARIOS, gateFor, switchSource } from "../scripts/verify/scenarios.mjs";
import { cleanVerificationEnv } from "../scripts/verify/bridge.mjs";
import { assessRun, createRunDefinition, FINGERPRINT_SCOPE } from "../scripts/verify/summary.mjs";
import { captureCodeState, fingerprintEntries, main, runSlot } from "../scripts/verify/run.mjs";
import { createTimeoutPolicy, runtimeTimeouts } from "../scripts/verify/timeouts.mjs";
import { loadRun } from "../scripts/verify/report.mjs";
import { evaluateStoredSlot } from "../scripts/verify/drivers.mjs";
import { makeSlot } from "./fixtures/verify-evidence.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/verify/run.mjs", import.meta.url));
const MODEL = PRIMARY_MODELS[0], SCENARIO = SCENARIOS[0];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + "\n");
const SIDE_EFFECT_GUARD = `
  import fs from 'node:fs';
  import cp from 'node:child_process';
  import net from 'node:net';
  import http from 'node:http';
  import https from 'node:https';
  import Module, { syncBuiltinESMExports } from 'node:module';
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === '@github/copilot-sdk') {
      process.stderr.write('UNEXPECTED_SDK_RESOLUTION\\n');
      process.exit(99);
    }
    return resolveFilename.call(this, request, ...args);
  };
  const deny = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };
  for (const key of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'createWriteStream']) fs[key] = deny;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
  net.connect = net.createConnection = net.createServer = deny;
  http.request = http.get = https.request = https.get = globalThis.fetch = deny;
  syncBuiltinESMExports();
`;
function temporary(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function cli(t, args, { dryRun = false } = {}) {
  const dir = temporary(t, "verify-runner-cli-");
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(SIDE_EFFECT_GUARD)}`,
    RUNNER, "--out", path.join(dir, "runs"), ...(dryRun ? ["--dry-run"] : []), ...args], {
    cwd: dir, env: { ...process.env, HOME: dir, CLAUDE_CODE_BIN: process.execPath, PENDING_TOOL_WAIT_MS: "10000" },
    encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.deepEqual(fs.readdirSync(dir), [], "validation must not create artifacts");
  assert.doesNotMatch(result.stderr, /UNEXPECTED_SIDE_EFFECT|UNEXPECTED_SDK_RESOLUTION/);
  return result;
}

test("CLI rejects invalid concurrency before any side effect", t => {
  for (const raw of [undefined, "", " \t", "NaN", "Infinity", "-Infinity", "1e309", "nope", "1.5", "0", "-1", "9007199254740992", "--help"]) {
    const result = cli(t, ["--model-concurrency", ...(raw === undefined ? [] : [raw])]);
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(raw)}`);
    assert.match(result.stderr, /--model-concurrency must be a positive safe integer/);
    assert.doesNotMatch(result.stdout, /execution:|artifacts:/);
  }
});
for (const [flag, valid] of [["--models", MODEL], ["--scenarios", "V01"]]) {
  test(`CLI rejects empty, duplicate and unknown ${flag} before side effects`, t => {
    for (const raw of [undefined, "", " ", ",", `${valid},`, `,${valid}`, `${valid},,${valid}`, `${valid}, ${valid}`, "unknown", "--dry-run"]) {
      const result = cli(t, [flag, ...(raw === undefined ? [] : [raw])]);
      assert.notEqual(result.status, 0, `accepted ${flag} ${JSON.stringify(raw)}`);
      assert.match(result.stderr, /[Mm]odel|[Ss]cenario/);
      assert.doesNotMatch(result.stdout, /execution:|artifacts:/);
    }
  });
}
test("CLI dry-run distinguishes the complete 36-slot matrix and focused axes without I/O", t => {
  const full = cli(t, ["--model-concurrency", "9007199254740991"], { dryRun: true });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /scope:\s+full/);
  assert.match(full.stdout, /slots:\s+36/);
  assert.match(full.stdout, /policy:.*strict-all-pass-v2/);
  const focused = cli(t, ["--models", MODEL], { dryRun: true });
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stdout, /scope:\s+focused/);
  assert.match(focused.stdout, /slots:\s+6/);
  const one = cli(t, ["--models", MODEL, "--scenarios", "V04"], { dryRun: true });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /slots:\s+1/);
  assert.match(one.stdout, /"modelConcurrency":1/);
  assert.doesNotMatch(full.stdout + focused.stdout, /coverage|scheduling estimate|scenarioConcurrency/);
});
test("main dry-run and help never call injected I/O dependencies", async () => {
  const deny = () => assert.fail("dry-run reached an I/O edge"), output = [];
  const deps = { env: {}, log: line => output.push(line), captureCodeState: deny, captureReference: deny,
    readCopilotSdkVersion: deny, resolveClaudeBin: deny, claudeVersion: deny, preflightCLI: deny, runSlot: deny };
  assert.equal(await main(["--dry-run"], deps), 0);
  assert.equal(await main(["--help"], deps), 0);
  assert.match(output.join("\n"), /36 slots/);
});
test("removed and unknown flags are rejected before any side effect", t => {
  for (const flag of ["--scenarios=V01", "--scenario-concurrency", "--scenario-concurrency=1", "--surprise"]) {
    const result = cli(t, [flag]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument/);
  }
});
test("child environment isolation preserves Copilot credentials without changing its parent", () => {
  const env = Object.freeze({ PATH: "/bin", HOME: "/fixture", GH_TOKEN: "fixture-gh-token", COPILOT_GITHUB_TOKEN: "fixture-copilot-token",
    PENDING_TOOL_WAIT_MS: "30000", COPILOT_CLI_PATH: "/fixture/copilot", ANTHROPIC_API_KEY: "wrong", ANTHROPIC_BASE_URL: "wrong", CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_USE_VERTEX: "1", BRIDGE_TEST_FAULTS: "fixture-fault", BRIDGE_LEASE_DIR: "/shared/lease",
    NODE_OPTIONS: "--import unwanted", ENABLE_TOOL_SEARCH: "1", OPENAI_API_KEY: "wrong", AZURE_OPENAI_ENDPOINT: "wrong" });
  assert.deepEqual(cleanVerificationEnv(env), { PATH: "/bin", HOME: "/fixture", GH_TOKEN: "fixture-gh-token", COPILOT_GITHUB_TOKEN: "fixture-copilot-token",
    PENDING_TOOL_WAIT_MS: "30000", COPILOT_CLI_PATH: "/fixture/copilot" });
  assert.equal(env.ANTHROPIC_API_KEY, "wrong");
  assert.equal(env.BRIDGE_LEASE_DIR, "/shared/lease");
});

function codeState(value = "a".repeat(64)) {
  return { git: { commit: "b".repeat(40), dirty: true }, fingerprint: { algorithm: "sha256", scope: FINGERPRINT_SCOPE, value, files: 1 } };
}
function passingSlot(t, id, model, preflight = { plugins: [] }) {
  const input = makeSlot(t, id, model);
  input.evidence.facts.preflight = structuredClone(preflight);
  const result = { ...input, ...evaluateStoredSlot(input), durationMs: 1, cleanup: { ok: true, bridges: [{ ok: true }] } };
  result.evidence.settings = { ok: true, files: [{ before: "c".repeat(64), after: "c".repeat(64) }] };
  assert.equal(result.outcome, "pass", `${model} ${id}: ${result.reason}`);
  return result;
}
function strictFixture(t, models = PRIMARY_MODELS, scenarios = SCENARIOS) {
  const slots = models.flatMap(model => scenarios.map(s => passingSlot(t, s.id, model)));
  return { slots, summary: { ...createRunDefinition(models, scenarios), actualTotal: slots.length,
    mode: "live", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:03.000Z",
    claude: { realpath: "/synthetic/claude", version: "fixture", sha256: "d".repeat(64), endSha256: "d".repeat(64) },
    userSettings: { intact: true, before: "missing", after: "missing" },
    provenance: { start: codeState(), end: codeState(), sources: { path: "sources/manifest.json", sha256: "e".repeat(64) } },
    artifacts: { slots: { sha256: "f".repeat(64) }, manifest: { sha256: "f".repeat(64) } }, cleanup: { ok: true } } };
}
test("strict grading requires 36 of 36 and never counts blocked as passing", t => {
  const run = strictFixture(t), grade = assessRun(run.summary, run.slots);
  assert.equal(gateFor(36), 36);
  assert.equal(grade.green, true, grade.problems.join("\n"));
  assert.equal(grade.gate, 36);
  assert.equal(grade.expectedTotal, 36);
  assert.equal(grade.actualTotal, 36);
  assert.equal(grade.complete, true);
  assert.equal(grade.scope.kind, "full");
  for (const outcome of ["fail", "blocked"]) {
    const slots = run.slots.map((s, i) => ({ ...s, outcome: i === 0 ? outcome : "pass" }));
    const failed = assessRun(run.summary, slots);
    assert.equal(failed.green, false);
    assert.equal(failed.counts.pass, 35);
    assert.equal(failed.expectedTotal, 36);
    assert.equal(failed.gate, 36);
  }
});
test("strict grading fails closed for incomplete, duplicate, unexpected and unknown records", t => {
  const run = strictFixture(t);
  const cases = [[], run.slots.slice(1), [...run.slots, run.slots[0]], [run.slots[0], ...run.slots.slice(0, -1)],
    ...[{ model: "unexpected" }, { scenario: "unexpected" }, { outcome: "unknown" }, { outcome: "__proto__" }, { outcome: undefined }]
      .map(change => [...run.slots.slice(1), { ...run.slots[0], ...change }]), [...run.slots.slice(1), null]];
  for (const slots of cases) {
    const grade = assessRun({ ...run.summary, actualTotal: slots.length }, slots);
    assert.equal(grade.green, false);
    assert.equal(grade.expectedTotal, 36, "completed rows cannot shrink the denominator");
    assert.ok(grade.problems.length > 0);
  }
});
test("canonical metadata and evidence are required; focused success is not full success", t => {
  assert.throws(() => createRunDefinition([], []));
  assert.throws(() => createRunDefinition([MODEL, MODEL], [SCENARIO]));
  assert.throws(() => createRunDefinition([MODEL], [SCENARIO, SCENARIO]));
  assert.throws(() => createRunDefinition(["unknown"], [SCENARIO]));
  const { summary, slots } = strictFixture(t, [MODEL], [SCENARIO]), grade = assessRun(summary, slots);
  assert.equal(summary.expectedSlots.length, 1);
  assert.equal(grade.green, true, grade.problems.join("\n"));
  assert.equal(grade.scope.kind, "focused");
  assert.equal(grade.scope.fullMatrixTotal, 36);
  for (const field of ["suiteId", "schemaVersion", "policy", "models", "scenarios", "scope", "expectedSlots", "expectedTotal", "actualTotal", "userSettings", "provenance", "mode", "finishedAt", "claude", "artifacts", "cleanup"]) {
    const incomplete = structuredClone(summary); delete incomplete[field];
    assert.notEqual(assessRun(incomplete, slots).green, true, `missing ${field}`);
  }
  for (const change of [{ expectedSlots: [] }, { expectedSlots: [summary.expectedSlots[0], summary.expectedSlots[0]] },
    { expectedTotal: 0 }, { actualTotal: 0 }, { models: [] }, { scenarios: [] }, { scope: { ...summary.scope, kind: "full" } },
    { safetyStop: "isolation failed" }, { scenarios: [{ ...SCENARIO, phases: [] }] }]) assert.equal(assessRun({ ...summary, ...change }, slots).green, false);
  for (const alter of [s => { s.checks = []; }, s => { s.evidence.phases = {}; }, s => { delete s.evidence.facts; },
    s => { s.cleanup.ok = false; }, s => { s.evidence.settings.files = []; }]) {
    const slot = structuredClone(slots[0]); alter(slot);
    assert.equal(assessRun(summary, [slot]).green, false);
  }
});
test("strict grading detects settings, code and binary changes with all slots passing", t => {
  const { summary, slots } = strictFixture(t, [MODEL], [SCENARIO]);
  for (const state of [{ intact: false, before: "a", after: "b" }, { intact: true, before: "a", after: "b" }, { intact: true }])
    assert.equal(assessRun({ ...summary, userSettings: state }, slots).green, false);
  for (const alter of [s => { s.provenance.end.fingerprint.value = "c".repeat(64); }, s => { s.provenance.end.git.commit = "d".repeat(40); },
    s => { delete s.provenance.end; }, s => { s.provenance.end.fingerprint = null; }, s => { s.provenance.start.git.commit = null; },
    s => { s.claude.endSha256 = "e".repeat(64); }]) {
    const changed = structuredClone(summary); alter(changed);
    assert.equal(assessRun(changed, slots).green, false);
  }
  const docsOnly = structuredClone(summary); docsOnly.provenance.start.git.dirty = false;
  assert.equal(assessRun(docsOnly, slots).green, true);
});
test("legacy grading preserves stored policy without inferring strict success", t => {
  const { summary, slots } = strictFixture(t, [MODEL], [SCENARIO]);
  const legacy = { models: summary.models, scenarios: summary.scenarios, gate: 74, green: true }, result = assessRun(legacy, slots);
  assert.equal(result.policyKind, "legacy"); assert.equal(result.gate, 74); assert.equal(result.storedGreen, true); assert.equal(result.green, false);
  const missing = assessRun({}, slots);
  assert.equal(missing.gate, null); assert.equal(missing.expectedTotal, null); assert.equal(missing.green, false); assert.equal(legacy.gate, 74);
});

test("fingerprint freezes tracked/untracked source and tests, excluding secrets/docs/evidence", t => {
  const root = temporary(t, "verify-code-state-");
  execFileSync("git", ["init", "--quiet", root]);
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const sources = { "src/tracked.mjs": "export const value = 1;\n", "scripts/verify/new-helper.mjs": "export const value = 1;\n",
    "bin/runner": "#!/bin/sh\nexit 0\n", "package.json": "{}\n", "package-lock.json": "{}\n", "test/test.mjs": "test\n", "test/fixtures/input.txt": "fixture\n" };
  for (const [name, value] of Object.entries(sources)) write(name, value);
  execFileSync("git", ["-C", root, "add", "--", "src/tracked.mjs"]);
  const artifactDir = path.join(root, "scripts/verify/test-artifacts"), snapshot = () => captureCodeState(root, { artifactDir });
  const baseline = snapshot();
  assert.equal(baseline.git.dirty, true); assert.equal(baseline.fingerprint.scope, FINGERPRINT_SCOPE);
  assert.match(baseline.fingerprint.value, /^[a-f0-9]{64}$/); assert.equal(baseline.fingerprint.files, 7);
  for (const [name, original] of Object.entries(sources)) {
    write(name, `${original}\n`); assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value, name); write(name, original);
  }
  write("src/another-new.mjs", "export default true;\n"); assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value);
  fs.rmSync(path.join(root, "src/another-new.mjs")); fs.rmSync(path.join(root, "src/tracked.mjs"));
  assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value, "tracked deletion"); write("src/tracked.mjs", sources["src/tracked.mjs"]);
  for (const name of [".env", "README.md", "docs/VERIFICATION.md", ".verify-runs/test/slots.jsonl", "src/debug.log", "scripts/verify/notes.md", "scripts/verify/test-artifacts/slots.jsonl"])
    write(name, "must not freeze\n");
  assert.deepEqual(snapshot().fingerprint, baseline.fingerprint);
  const frozen = captureCodeState(root, { artifactDir, freeze: true });
  assert.deepEqual(frozen.fingerprint, baseline.fingerprint);
  const bytes = fs.readFileSync(path.join(artifactDir, frozen.sources.path));
  assert.equal(sha(bytes), frozen.sources.sha256);
  for (const entry of JSON.parse(bytes).entries) {
    assert.equal(fs.readFileSync(path.join(artifactDir, entry.copy), "utf8"), sources[entry.path]);
    assert.equal(entry.sha256, sha(sources[entry.path]));
  }
});

/** main's external execution edges are injected; sealing/replay/finalization stay real. */
async function completedRun(t, { models = PRIMARY_MODELS, scenarios = SCENARIOS, outcome = "pass", change = "none", sdkVersion = "9.8.7", blocked, breach = false, concurrency = 1 } = {}) {
  const dir = temporary(t, "verify-runner-completion-"), rootDir = path.join(dir, "checkout"), out = path.join(dir, "runs");
  fs.mkdirSync(rootDir);
  const binary = path.join(dir, "claude-fixture"), source = path.join(rootDir, "package.json"), userSettingsPath = path.join(dir, "user-settings.json");
  fs.writeFileSync(binary, "inert binary bytes, never executed\n"); fs.writeFileSync(source, "{}\n");
  const output = [], called = [], active = new Set(); let overlap = false;
  const capture = (_root, { artifactDir, freeze = false }) => {
    const bytes = fs.readFileSync(source), entry = { path: "package.json", kind: "file", executable: 0, bytes: bytes.length, sha256: sha(bytes) };
    const state = codeState(fingerprintEntries([entry]));
    if (freeze) {
      entry.copy = "sources/files/package.json"; fs.mkdirSync(path.join(artifactDir, "sources/files"), { recursive: true });
      fs.writeFileSync(path.join(artifactDir, entry.copy), bytes);
      json(path.join(artifactDir, "sources/manifest.json"), { schemaVersion: 2, fingerprint: state.fingerprint, entries: [entry] });
      state.sources = { path: "sources/manifest.json", sha256: sha(fs.readFileSync(path.join(artifactDir, "sources/manifest.json"))) };
    }
    return state;
  };
  const code = await main(["--out", out, "--models", models.join(","), "--scenarios", scenarios.map(s => s.id).join(","), "--model-concurrency", String(concurrency)], {
    rootDir, env: {}, userSettingsPath, log: line => output.push(line), captureCodeState: capture,
    captureReference: () => ({ commit: null, files: [] }), readCopilotSdkVersion: () => sdkVersion,
    resolveClaudeBin: () => binary, claudeVersion: () => "offline-fixture",
    preflightCLI: async ({ claudeBin }) => {
      if (blocked === "throw") throw new Error("offline preflight unavailable");
      return { claude: { bin: claudeBin, sha256: blocked === "identity" ? "0".repeat(64) : sha(fs.readFileSync(binary)), version: "offline-fixture" },
        cleanup: { ok: blocked !== "cleanup" }, plugins: [], scenarios: Object.fromEntries(SCENARIOS.map(s => [s.id, { ok: blocked !== s.id, reason: "fixture capability unavailable" }])) };
    },
    runSlot: async options => {
      assert.ok(!active.has(options.model), "scenarios for the same model must stay sequential");
      active.add(options.model); if (active.size > 1) overlap = true;
      await new Promise(resolve => setImmediate(resolve));
      const saved = JSON.parse(fs.readFileSync(path.join(options.runDir, "summary.json")));
      assert.equal(saved.expectedTotal, models.length * scenarios.length); assert.equal(saved.green, false); assert.equal(saved.provenance.end, null);
      assert.deepEqual(saved.copilotSdk, { version: sdkVersion }); assert.deepEqual(saved.preflight, options.preflight);
      called.push([options.model, options.scenario.id]);
      const slot = passingSlot(t, options.scenario.id, options.model, options.preflight);
      if (outcome !== "pass") { slot.outcome = outcome; slot.reason = `offline ${outcome}`; }
      if (change === "code") fs.appendFileSync(source, " ");
      if (change === "docs") fs.writeFileSync(path.join(rootDir, "README.md"), "generated");
      if (change === "settings") fs.writeFileSync(userSettingsPath, "{}");
      if (change === "binary") fs.appendFileSync(binary, "changed");
      if (breach) { slot.cleanup.ok = false; slot.safetyBreach = true; }
      active.delete(options.model);
      return slot;
    },
  });
  const dirs = fs.readdirSync(out); assert.equal(dirs.length, 1);
  const runDir = path.join(out, dirs[0]), loaded = loadRun(runDir), { summary, slots } = loaded;
  assert.ok(summary.finishedAt); assert.deepEqual(summary.copilotSdk, { version: sdkVersion });
  assert.equal(summary.expectedTotal, models.length * scenarios.length); assert.equal(summary.actualTotal, summary.expectedTotal);
  assert.equal(slots.length, summary.expectedTotal); assert.equal(summary.gate, summary.expectedTotal);
  assert.deepEqual(loaded.integrityProblems, [], loaded.integrityProblems.join("\n"));
  assert.equal(loaded.assessment.green, summary.green);
  assert.match(output.join("\n"), /artifacts:.*\nreport:/);
  return { code, summary, slots, called, overlap, runDir };
}
test("main completes all 36 genuine synthetic slots, seals artifacts and runs model lanes concurrently", async t => {
  const run = await completedRun(t, { concurrency: 3 });
  assert.equal(run.code, 0); assert.equal(run.summary.green, true); assert.equal(run.summary.scope.kind, "full");
  assert.equal(run.summary.counts.pass, 36); assert.equal(run.overlap, true);
  for (const model of PRIMARY_MODELS) assert.deepEqual(run.called.filter(c => c[0] === model).map(c => c[1]), SCENARIOS.map(s => s.id));
});
test("main retains focused outcomes, initial SDK metadata and strict v2 denominator", async t => {
  for (const outcome of ["pass", "fail", "blocked", "unknown"]) {
    const run = await completedRun(t, { models: [MODEL], scenarios: [SCENARIO], outcome, sdkVersion: null });
    assert.equal(run.code, outcome === "pass" ? 0 : 1); assert.equal(run.summary.green, outcome === "pass");
    assert.equal(run.summary.scope.kind, "focused"); assert.equal(run.summary.policy.id, "strict-all-pass-v2");
    assert.equal(run.summary.counts[outcome], 1);
  }
});
test("main blocks unavailable preflight without launching slots or shrinking the matrix", async t => {
  for (const blocked of ["throw", "identity", "cleanup", "V03"]) {
    const run = await completedRun(t, { models: [MODEL], blocked });
    assert.equal(run.code, 1); assert.equal(run.summary.green, false); assert.equal(run.summary.expectedTotal, 6);
    assert.equal(run.called.length, blocked === "V03" ? 5 : 0);
    assert.equal(run.summary.counts.blocked, blocked === "V03" ? 1 : 6);
  }
});
test("safety breach stops future slots but keeps all 36 denominator records", async t => {
  const run = await completedRun(t, { breach: true });
  assert.equal(run.code, 1); assert.equal(run.called.length, 1); assert.equal(run.summary.expectedTotal, 36);
  assert.equal(run.summary.counts.blocked, 35); assert.match(run.summary.safetyStop, /Isolation or cleanup breach/);
});
test("main refuses changed settings/code/binary but ignores generated documentation", async t => {
  for (const change of ["code", "settings", "binary", "docs"]) {
    const run = await completedRun(t, { models: [MODEL], scenarios: [SCENARIO], change });
    assert.equal(run.summary.counts.pass, 1); assert.equal(run.summary.green, change === "docs");
    assert.equal(run.code, change === "docs" ? 0 : 1);
    if (change === "code") assert.equal(run.summary.assessment.codeUnchanged, false);
    if (change === "settings") assert.equal(run.summary.assessment.userSettingsIntact, false);
  }
});

async function lifecycle(t, id, { model = MODEL, action, cleanupOk = true, healthOk = true, keepWorkspaces = false } = {}) {
  const root = temporary(t, "verify-slot-lifecycle-"), runDir = path.join(root, "run"); fs.mkdirSync(runDir);
  const scenario = SCENARIOS.find(s => s.id === id), env = {}, runtime = runtimeTimeouts(env), bridges = [], order = [], contexts = [];
  const record = await runSlot({ model, scenario, runDir, claudeBin: "/never-executed", version: "offline-fixture", preflight: { plugins: [] },
    keepWorkspaces, timeouts: createTimeoutPolicy([scenario], 1), expectedRuntimeTimeouts: runtime, rootDir: root, env }, {
    startBridge: async options => {
      const index = bridges.length, bridge = { model: options.model, frontendModel: `frontend-${options.model}`, token: `secret-${index}`, baseUrl: `http://127.0.0.1:${12000 + index}`,
        pid: 200 + index, port: 12000 + index, health: { timeouts: healthOk ? runtime : {} }, metadata: { instanceId: `fixture-${index}` }, logPath: options.logPath, stops: 0 };
      bridge.stop = async () => { bridge.stops++; order.push(`stop-${index}`); return { ok: cleanupOk, pid: bridge.pid, groupGone: cleanupOk, portReleased: cleanupOk }; };
      fs.writeFileSync(options.logPath, "synthetic bridge log\n"); bridges.push(bridge); order.push(`start-${index}`); return bridge;
    },
    seedConfigDir: (dir, options) => { assert.equal(options.version, "offline-fixture"); fs.mkdirSync(dir, { recursive: true }); },
    writeLaunchSettings: ({ bridge, settingsPath }) => json(settingsPath, { env: { ANTHROPIC_BASE_URL: bridge.baseUrl, ANTHROPIC_AUTH_TOKEN: bridge.token, ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: bridge.frontendModel } }),
    DRIVERS: { [id]: async ctx => {
      contexts.push(ctx); t.after(() => fs.rmSync(path.dirname(ctx.workspace), { recursive: true, force: true }));
      const settings = JSON.parse(fs.readFileSync(ctx.settingsPath));
      // Production credential path: Bearer bridge token, blank API key.
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, ctx.bridge.token); assert.equal(settings.env.ANTHROPIC_API_KEY, "");
      assert.equal(settings.disableAllHooks, true); assert.equal(settings.autoMemoryEnabled, false);
      assert.equal(fs.statSync(ctx.settingsPath).mode & 0o777, 0o600);
      assert.ok(!ctx.workspace.startsWith(root + path.sep));
      assert.equal(ctx.deadline - Date.parse(new Date(ctx.deadline - ctx.timeoutSeconds * 1000).toISOString()), ctx.timeoutSeconds * 1000);
      await action?.(ctx, { order, bridges });
      return passingSlot(t, id, model, ctx.preflight);
    } },
  });
  if (record.workspace) t.after(() => fs.rmSync(path.dirname(record.workspace), { recursive: true, force: true }));
  return { record, contexts, bridges, order };
}
test("runSlot bootstraps V04 on the declared source model, then retains requested target identity", async t => {
  for (const model of [MODEL, "claude-haiku-4.5"]) {
    const { record, contexts, bridges } = await lifecycle(t, "V04", { model });
    assert.equal(bridges[0].model, switchSource(model)); assert.notEqual(bridges[0].model, model);
    assert.equal(contexts[0].model, model); assert.equal(record.model, model); assert.equal(record.outcome, "pass", record.reason);
    assert.equal(bridges[0].stops, 1); assert.equal(record.cleanup.ok, true); assert.equal(record.evidence.settings.files.length, 1);
    assert.equal(fs.existsSync(contexts[0].workspace), false, "successful temporary workspace removed");
  }
});
test("V06 restart reaps the old bridge before replacement and hashes both immutable settings", async t => {
  const { record, bridges, order } = await lifecycle(t, "V06", { action: async ctx => {
    const original = fs.readFileSync(ctx.settingsPath), deadline = ctx.deadline;
    const next = await ctx.restartBridge();
    assert.notEqual(next.bridge.pid, ctx.bridge.pid); assert.notEqual(next.settingsPath, ctx.settingsPath);
    assert.equal(next.cleanup.ok, true); assert.deepEqual(fs.readFileSync(ctx.settingsPath), original);
    assert.equal(ctx.deadline, deadline, "restart cannot renew the slot deadline");
    const settings = JSON.parse(fs.readFileSync(next.settingsPath));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, next.bridge.token); assert.equal(settings.env.ANTHROPIC_API_KEY, "");
  } });
  assert.equal(record.outcome, "pass", record.reason); assert.deepEqual(order, ["start-0", "stop-0", "start-1", "stop-1"]);
  assert.deepEqual(bridges.map(b => b.stops), [1, 1]); assert.equal(record.cleanup.bridges.length, 2);
  assert.equal(record.evidence.settings.files.length, 2);
  assert.ok(record.evidence.settings.files.every(f => f.before === f.after));
});
test("runSlot refuses unsafe V06 replacement and detects settings mutation", async t => {
  const failed = await lifecycle(t, "V06", { cleanupOk: false, action: ctx => ctx.restartBridge() });
  assert.equal(failed.bridges.length, 1); assert.equal(failed.bridges[0].stops, 1);
  assert.equal(failed.record.safetyBreach, true); assert.equal(failed.record.cleanup.ok, false); assert.notEqual(failed.record.outcome, "pass");
  const changed = await lifecycle(t, "V06", { action: async ctx => { await ctx.restartBridge(); fs.appendFileSync(ctx.settingsPath, " "); } });
  assert.equal(changed.record.outcome, "fail"); assert.equal(changed.record.safetyBreach, true); assert.equal(changed.record.evidence.settings.ok, false);
  assert.ok(fs.existsSync(changed.record.workspace), "failed workspace retained");
});
test("runSlot blocks incorrect runtime health and cleans up after driver exceptions", async t => {
  const health = await lifecycle(t, "V01", { healthOk: false });
  assert.equal(health.contexts.length, 0); assert.equal(health.record.outcome, "blocked"); assert.equal(health.bridges[0].stops, 1);
  assert.match(health.record.reason, /timeout budgets/);
  assert.deepEqual(Object.keys(health.record.evidence.phases), SCENARIO.phases.map(p => p.id));
  const failed = await lifecycle(t, "V01", { action: () => { throw new Error("offline driver failure"); } });
  assert.equal(failed.record.outcome, "blocked"); assert.equal(failed.record.cleanup.ok, true); assert.equal(failed.bridges[0].stops, 1);
  const retained = await lifecycle(t, "V01", { keepWorkspaces: true });
  assert.equal(retained.record.outcome, "pass"); assert.ok(fs.existsSync(retained.record.workspace));
});

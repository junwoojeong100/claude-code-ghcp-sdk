/** Offline runner guards and completion fixtures. No test launches Claude or a network request. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRIMARY_MODELS, SCENARIOS, gateFor } from "../scripts/verify/scenarios.mjs";
import { coverage } from "../scripts/verify/features.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/verify/run.mjs", import.meta.url));
const MODEL = PRIMARY_MODELS[0];
const SCENARIO = SCENARIOS[0];
const SIDE_EFFECT_GUARD = `
  import fs from 'node:fs';
  import cp from 'node:child_process';
  import net from 'node:net';
  import http from 'node:http';
  import https from 'node:https';
  import { syncBuiltinESMExports } from 'node:module';
  const deny = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };
  for (const key of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'createWriteStream']) fs[key] = deny;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
  net.connect = net.createConnection = net.createServer = deny;
  http.request = http.get = https.request = https.get = globalThis.fetch = deny;
  syncBuiltinESMExports();
`;

function cli(t, args, { dryRun = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-runner-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(SIDE_EFFECT_GUARD)}`,
    RUNNER, "--out", path.join(dir, "runs"), ...(dryRun ? ["--dry-run"] : []), ...args,
  ], {
    cwd: dir,
    env: { ...process.env, HOME: dir, CLAUDE_CODE_BIN: process.execPath, PENDING_TOOL_WAIT_MS: "10000" },
    encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.deepEqual(fs.readdirSync(dir), [], "validation must not create artifacts");
  assert.doesNotMatch(result.stderr, /UNEXPECTED_SIDE_EFFECT/, "validation must precede external processes, network and writes");
  return result;
}

for (const flag of ["--model-concurrency", "--scenario-concurrency"]) {
  test(`CLI rejects invalid ${flag} before any side effect`, (t) => {
    for (const raw of [undefined, "", " \t", "NaN", "Infinity", "-Infinity", "1e309", "nope", "1.5", "0", "-1", "9007199254740992", "--help"]) {
      const result = cli(t, [flag, ...(raw === undefined ? [] : [raw])]);
      assert.notEqual(result.status, 0, `accepted ${flag} ${JSON.stringify(raw)}`);
      assert.match(result.stderr, new RegExp(`${flag} must be a positive safe integer`));
      assert.doesNotMatch(result.stdout, /execution:|artifacts:/);
    }
  });
}

for (const [flag, valid] of [["--models", MODEL], ["--scenarios", SCENARIO.id]]) {
  test(`CLI rejects empty, duplicate and unknown ${flag} before side effects`, (t) => {
    for (const raw of [undefined, "", " ", ",", `${valid},`, `,${valid}`, `${valid},,${valid}`, `${valid}, ${valid}`, "unknown", "--dry-run"]) {
      const result = cli(t, [flag, ...(raw === undefined ? [] : [raw])]);
      assert.notEqual(result.status, 0, `accepted ${flag} ${JSON.stringify(raw)}`);
      assert.match(result.stderr, /[Mm]odel|[Ss]cenario/);
      assert.doesNotMatch(result.stdout, /execution:|artifacts:/);
    }
  });
}

test("CLI dry-run accepts positive safe integers and distinguishes full from focused coverage", (t) => {
  const full = cli(t, ["--model-concurrency", "9007199254740991", "--scenario-concurrency", "1"], { dryRun: true });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /scope:\s+full/);
  assert.match(full.stdout, /slots:\s+66/);
  assert.match(full.stdout, /policy:.*strict-all-pass-v1/);
  const focused = cli(t, ["--models", MODEL, "--scenarios", SCENARIO.id], { dryRun: true });
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stdout, /scope:\s+focused/);
  assert.match(focused.stdout, /slots:\s+1/);
  assert.ok(focused.stdout.includes(`coverage:  ${coverage([SCENARIO]).percent}%`));
  assert.doesNotMatch(focused.stdout, /coverage:\s+9\d(?:\.\d)?%/);
});

function codeState(value = "a".repeat(64)) {
  return {
    git: { commit: "b".repeat(40), dirty: true },
    fingerprint: { algorithm: "sha256", scope: "verification-code-v1", value, files: 3 },
  };
}

async function strictFixture(models = PRIMARY_MODELS, scenarios = SCENARIOS) {
  const { createRunDefinition } = await import("../scripts/verify/summary.mjs");
  const definition = createRunDefinition(models, scenarios);
  const slots = models.flatMap((model) => scenarios.map((s) => ({ model, scenario: s.id, outcome: "pass" })));
  return {
    summary: {
      ...definition,
      models: [...models], scenarios: scenarios.map((s) => ({ id: s.id })), actualTotal: slots.length,
      userSettings: { intact: true, before: "missing", after: "missing" },
      provenance: { start: codeState(), end: codeState() },
    },
    slots,
  };
}

test("strict grading requires 66 of 66, not 63 of 66, and never passes blocked slots", async () => {
  const { assessRun } = await import("../scripts/verify/summary.mjs");
  const run = await strictFixture();
  const grade = assessRun(run.summary, run.slots);
  assert.equal(gateFor(66), 66);
  assert.equal(grade.green, true);
  assert.equal(grade.gate, 66);
  assert.equal(grade.expectedTotal, 66);
  assert.equal(grade.actualTotal, 66);
  assert.equal(grade.complete, true);
  assert.equal(grade.scope.kind, "full");
  for (const outcome of ["fail", "blocked"]) {
    const slots = run.slots.map((s, i) => ({ ...s, outcome: i < 3 ? outcome : "pass" }));
    const failed = assessRun(run.summary, slots);
    assert.equal(failed.green, false);
    assert.equal(failed.counts.pass, 63);
    assert.equal(failed.expectedTotal, 66);
    assert.equal(failed.gate, 66);
  }
});

test("strict grading fails closed for incomplete, duplicate, unexpected and unknown records", async () => {
  const { assessRun } = await import("../scripts/verify/summary.mjs");
  const run = await strictFixture();
  const cases = [
    [], run.slots.slice(1), [...run.slots, run.slots[0]],
    [run.slots[0], ...run.slots.slice(0, -1)],
    [...run.slots.slice(1), { ...run.slots[0], model: "unexpected" }],
    [...run.slots.slice(1), { ...run.slots[0], scenario: "unexpected" }],
    [...run.slots.slice(1), { ...run.slots[0], outcome: "unknown" }],
    [...run.slots.slice(1), { ...run.slots[0], outcome: "__proto__" }],
    [...run.slots.slice(1), { ...run.slots[0], outcome: undefined }],
    [...run.slots.slice(1), null],
  ];
  for (const slots of cases) {
    const grade = assessRun({ ...run.summary, actualTotal: slots.length }, slots);
    assert.equal(grade.green, false, JSON.stringify(slots.at(-1)));
    assert.equal(grade.expectedTotal, 66, "completed rows cannot shrink the denominator");
    assert.ok(grade.problems.length > 0);
  }
});

test("strict metadata is independent, nonempty and complete; a focused pass is not a full pass", async () => {
  const { assessRun, createRunDefinition } = await import("../scripts/verify/summary.mjs");
  assert.throws(() => createRunDefinition([], []));
  assert.throws(() => createRunDefinition([MODEL, MODEL], [SCENARIO]));
  assert.throws(() => createRunDefinition([MODEL], [SCENARIO, SCENARIO]));
  assert.throws(() => createRunDefinition(["unknown"], [SCENARIO]));
  const { summary, slots } = await strictFixture([MODEL], [SCENARIO]);
  assert.equal(summary.expectedSlots.length, 1);
  const grade = assessRun(summary, slots);
  assert.equal(grade.green, true);
  assert.equal(grade.scope.kind, "focused");
  assert.equal(grade.scope.fullMatrixTotal, 66);
  for (const field of ["policy", "models", "scenarios", "scope", "expectedSlots", "expectedTotal", "actualTotal", "userSettings", "provenance"]) {
    const incomplete = structuredClone(summary);
    delete incomplete[field];
    assert.notEqual(assessRun(incomplete, slots).green, true, `missing ${field}`);
  }
  for (const change of [
    { expectedSlots: [] }, { expectedSlots: [summary.expectedSlots[0], summary.expectedSlots[0]] },
    { expectedTotal: 0 }, { actualTotal: 0 }, { models: [] }, { scenarios: [] },
    { scope: { ...summary.scope, kind: "full" } },
  ]) {
    assert.equal(assessRun({ ...summary, ...change }, slots).green, false);
  }
});

test("strict grading detects settings, code and commit changes even with every slot passing", async () => {
  const { assessRun } = await import("../scripts/verify/summary.mjs");
  const { summary, slots } = await strictFixture([MODEL], [SCENARIO]);
  for (const state of [
    { intact: false, before: "a", after: "b" },
    { intact: true, before: "a", after: "b" },
    { intact: true },
  ]) {
    assert.equal(assessRun({ ...summary, userSettings: state }, slots).green, false);
  }
  for (const alter of [
    (s) => { s.provenance.end.fingerprint.value = "c".repeat(64); },
    (s) => { s.provenance.end.git.commit = "d".repeat(40); },
    (s) => { delete s.provenance.end; },
    (s) => { s.provenance.end.fingerprint = null; },
    (s) => { s.provenance.start.git.commit = null; },
  ]) {
    const changed = structuredClone(summary);
    alter(changed);
    assert.equal(assessRun(changed, slots).green, false);
  }
  const docsOnly = structuredClone(summary);
  docsOnly.provenance.start.git.dirty = false;
  assert.equal(assessRun(docsOnly, slots).green, true, "unrelated dirty-state changes are recorded, not hashed as code");
});

test("legacy grading preserves stored policy without inferring strict success", async () => {
  const { assessRun } = await import("../scripts/verify/summary.mjs");
  const { summary, slots } = await strictFixture();
  const legacy = { models: summary.models, scenarios: summary.scenarios, gate: 74, green: true };
  const result = assessRun(legacy, slots);
  assert.equal(result.policyKind, "legacy");
  assert.equal(result.gate, 74);
  assert.equal(result.storedGreen, true);
  assert.notEqual(result.green, true);
  const missing = assessRun({}, slots);
  assert.equal(missing.gate, null);
  assert.equal(missing.expectedTotal, null);
  assert.notEqual(missing.green, true);
  assert.equal(legacy.gate, 74);
});

test("code fingerprint covers tracked and untracked implementation, but not docs or run artifacts", async (t) => {
  const { captureCodeState } = await import("../scripts/verify/run.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-code-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("src/tracked.mjs", "export const value = 1;\n");
  write("scripts/verify/new-helper.mjs", "export const value = 1;\n");
  write("bin/runner", "#!/bin/sh\nexit 0\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  execFileSync("git", ["-C", root, "add", "--", "src/tracked.mjs"]);
  const artifactDir = path.join(root, "scripts/verify/test-artifacts");
  const snapshot = () => captureCodeState(root, { artifactDir });
  const baseline = snapshot();
  assert.equal(baseline.git.dirty, true);
  assert.equal(baseline.fingerprint.algorithm, "sha256");
  assert.match(baseline.fingerprint.value, /^[a-f0-9]{64}$/);
  assert.equal(baseline.fingerprint.files, 5);
  assert.deepEqual(snapshot().fingerprint, baseline.fingerprint);
  for (const [name, original] of [
    ["src/tracked.mjs", "export const value = 1;\n"],
    ["scripts/verify/new-helper.mjs", "export const value = 1;\n"],
    ["bin/runner", "#!/bin/sh\nexit 0\n"],
    ["package.json", "{}\n"], ["package-lock.json", "{}\n"],
  ]) {
    write(name, `${original}\n`);
    assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value, name);
    write(name, original);
  }
  write("src/another-new.mjs", "export default true;\n");
  assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value);
  fs.rmSync(path.join(root, "src/another-new.mjs"));
  fs.rmSync(path.join(root, "src/tracked.mjs"));
  assert.notEqual(snapshot().fingerprint.value, baseline.fingerprint.value, "tracked deletion");
  write("src/tracked.mjs", "export const value = 1;\n");
  for (const name of ["README.md", "docs/VERIFICATION.md", ".verify-runs/test/slots.jsonl", "src/debug.log", "scripts/verify/notes.md", "scripts/verify/test-artifacts/slots.jsonl"]) write(name, "generated\n");
  assert.deepEqual(snapshot().fingerprint, baseline.fingerprint);
});

/** Execute the unmodified runner in a disposable checkout with offline I/O edges. */
function completedRun(t, { full = false, outcome = "pass", change = "none" } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-runner-completion-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "checkout");
  const home = path.join(dir, "home");
  const temp = path.join(dir, "tmp");
  const out = path.join(dir, "runs");
  const sourceRoot = path.resolve(path.dirname(RUNNER), "../..");
  const files = [
    ...["run", "summary", "scenarios", "features", "timeouts"].map((name) => `scripts/verify/${name}.mjs`),
    "src/settings-file-state.mjs", "src/model-map.mjs",
  ];
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, name), path.join(root, name));
  }
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  files.push("package.json");
  const expected = full ? PRIMARY_MODELS.length * SCENARIOS.length : 3;
  const putModule = (name, code) => fs.writeFileSync(path.join(root, "scripts/verify", name), code);
  putModule("bridge.mjs", `
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    export const resolveClaudeBin = () => 'offline-fixture';
    export const claudeVersion = () => 'offline-fixture';
    export const startBridge = async () => ({ frontendModel: 'offline', port: 0, stop: async () => {} });
    export const assertModelServed = async () => {};
    export const writeLaunchSettings = () => {};
    export const seedConfigDir = () => {};
    export const readTail = () => '';
  `);
  putModule("fixtures.mjs", "export const buildFixture = () => ({});\n");
  putModule("drivers.mjs", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { SCENARIOS } from './scenarios.mjs';
    import { ROOT_DIR } from './bridge.mjs';
    async function run({ slotDir }) {
      const saved = JSON.parse(fs.readFileSync(path.resolve(slotDir, '../../summary.json'), 'utf8'));
      assert.equal(saved.expectedTotal, ${expected});
      assert.equal(saved.expectedSlots.length, ${expected});
      assert.equal(saved.green, false);
      assert.equal(saved.provenance.end, null);
      if (${JSON.stringify(change)} === 'code') fs.appendFileSync(path.join(ROOT_DIR, 'package.json'), ' ');
      if (${JSON.stringify(change)} === 'docs') fs.writeFileSync(path.join(ROOT_DIR, 'README.md'), 'generated');
      if (${JSON.stringify(change)} === 'settings') {
        fs.mkdirSync(path.join(os.homedir(), '.claude'), { recursive: true });
        fs.writeFileSync(path.join(os.homedir(), '.claude/settings.json'), '{}');
      }
      if (${JSON.stringify(outcome)} === 'blocked') throw new Error('offline blocked fixture');
      return { outcome: ${JSON.stringify(outcome)}, checks: [] };
    }
    export const DRIVERS = Object.fromEntries(SCENARIOS.map((s) => [s.id, run]));
  `);

  // No subprocess (including git) or network endpoint may run. Only the three
  // local provenance queries receive fixed responses; hashing uses real bytes.
  const guard = `
    import cp from 'node:child_process';
    import net from 'node:net';
    import http from 'node:http';
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('UNEXPECTED_SIDE_EFFECT'); };
    for (const key of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
    cp.spawnSync = (file, args) => {
      if (file !== 'git' || args[0] !== '--no-optional-locks' || args[2] !== ${JSON.stringify(root)}) return deny();
      const stdout = args[3] === 'rev-parse' ? '${"b".repeat(40)}' :
        args[3] === 'status' ? '' : args[3] === 'ls-files' ? ${JSON.stringify(files.join("\0") + "\0")} : null;
      if (stdout === null) return deny();
      return { status: 0, stdout };
    };
    net.connect = net.createConnection = net.createServer = deny;
    http.request = http.get = https.request = https.get = globalThis.fetch = deny;
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(guard)}`,
    path.join(root, "scripts/verify/run.mjs"), "--out", out,
    ...(full ? [] : ["--models", PRIMARY_MODELS.slice(0, 3).join(","), "--scenarios", SCENARIO.id]),
  ], {
    cwd: root, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
    env: { ...process.env, HOME: home, TMPDIR: temp, PENDING_TOOL_WAIT_MS: "10000" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /ReferenceError|UNEXPECTED_SIDE_EFFECT/);
  assert.ok(fs.existsSync(out), result.stderr);
  const runs = fs.readdirSync(out);
  assert.equal(runs.length, 1);
  const runDir = path.join(out, runs[0]);
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  const slots = fs.readFileSync(path.join(runDir, "slots.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(summary.finishedAt, "actual runner finalization must write a completed summary");
  assert.equal(summary.expectedTotal, expected);
  assert.equal(summary.actualTotal, expected);
  assert.equal(summary.gate, expected);
  assert.equal(slots.length, expected);
  assert.equal(summary.assessment.actualTotal, expected);
  assert.match(result.stdout, /artifacts:.*\nreport:/);
  return { result, summary, slots };
}

test("actual runner completion writes a strict full summary and all focused failure outcomes offline", (t) => {
  const full = completedRun(t, { full: true });
  assert.equal(full.result.status, 0, full.result.stderr);
  assert.equal(full.summary.green, true);
  assert.equal(full.summary.scope.kind, "full");
  assert.equal(full.summary.counts.pass, 66);
  assert.equal(full.summary.provenance.start.fingerprint.value, full.summary.provenance.end.fingerprint.value);
  for (const outcome of ["pass", "fail", "blocked", "unknown"]) {
    const run = completedRun(t, { outcome });
    assert.equal(run.result.status, outcome === "pass" ? 0 : 1, run.result.stderr);
    assert.equal(run.summary.green, outcome === "pass");
    assert.equal(run.summary.scope.kind, "focused");
    assert.equal(run.summary.counts[outcome], 3);
    assert.ok(run.slots.every((slot) => slot.outcome === outcome));
  }
});

test("actual runner completion refuses changed settings or code but ignores generated docs", (t) => {
  for (const change of ["code", "settings", "docs"]) {
    const run = completedRun(t, { change });
    assert.equal(run.summary.counts.pass, 3);
    assert.equal(run.summary.green, change === "docs");
    assert.equal(run.result.status, change === "docs" ? 0 : 1, run.result.stderr);
    if (change === "code") assert.equal(run.summary.assessment.codeUnchanged, false);
    if (change === "settings") assert.equal(run.summary.assessment.userSettingsIntact, false);
  }
});

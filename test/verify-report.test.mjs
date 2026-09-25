/** Synthetic reports only: no installed SDK lookup, model, bridge or document publishing. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRIMARY_MODELS, SCENARIOS } from "../scripts/verify/scenarios.mjs";
import { createRunDefinition, FINGERPRINT_SCOPE } from "../scripts/verify/summary.mjs";
import { fingerprintEntries, sealArtifacts } from "../scripts/verify/run.mjs";
import { loadRun, parseReportArgs, renderReport, verifySavedArtifacts, writeDocs } from "../scripts/verify/report.mjs";
import { evaluateStoredSlot } from "../scripts/verify/drivers.mjs";
import { runtimeTimeouts } from "../scripts/verify/timeouts.mjs";
import { makeSlot } from "./fixtures/verify-evidence.mjs";

const REPORT = fileURLToPath(new URL("../scripts/verify/report.mjs", import.meta.url));
const ROOT = path.resolve(path.dirname(REPORT), "../..");
const FORMATS = [{}, { markdown: true }, { markdown: true, lang: "ko" }];
const ID = SCENARIOS[0].id;
const scenario = (id) => SCENARIOS.find((s) => s.id === id);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + "\n");

/** Resealing is confined to disposable synthetic evidence, never a saved live run. */
function save(run) {
  const slotsPath = path.join(run.dir, "slots.jsonl"), manifestPath = path.join(run.dir, "artifact-manifest.json");
  fs.writeFileSync(slotsPath, run.slots.map(s => JSON.stringify(s)).join("\n") + "\n");
  if (!fs.existsSync(manifestPath)) run.summary.artifacts = sealArtifacts(run.dir);
  else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    for (const entry of manifest.entries) {
      const file = path.join(run.dir, entry.path);
      const bytes = entry.kind === "symlink" ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
      entry.bytes = bytes.length; entry.sha256 = sha(bytes);
    }
    json(manifestPath, manifest);
    run.summary.artifacts = { slots: { path: "slots.jsonl", sha256: sha(fs.readFileSync(slotsPath)) },
      manifest: { path: "artifact-manifest.json", sha256: sha(fs.readFileSync(manifestPath)) } };
  }
  json(path.join(run.dir, "summary.json"), run.summary);
}

function makeRun(t, { models = PRIMARY_MODELS.slice(0, 3), scenarios = [SCENARIOS[0]], mixed = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-report-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "run's artifacts $literal; data");
  fs.mkdirSync(path.join(dir, "sources/files/scripts/verify"), { recursive: true });
  const source = "export const synthetic = true;\n";
  const entries = [{ path: "scripts/verify/fixture.mjs", copy: "sources/files/scripts/verify/fixture.mjs", kind: "file", executable: 0, bytes: Buffer.byteLength(source), sha256: sha(source) }];
  fs.writeFileSync(path.join(dir, entries[0].copy), source);
  const state = { git: { commit: "b".repeat(40), dirty: true },
    fingerprint: { algorithm: "sha256", scope: FINGERPRINT_SCOPE, value: fingerprintEntries(entries), files: entries.length } };
  json(path.join(dir, "sources/manifest.json"), { schemaVersion: 2, fingerprint: state.fingerprint, entries });
  const claude = { bin: "/fixture/claude binary", realpath: "/fixture/claude binary", version: "fixture-cli", sha256: "d".repeat(64), endSha256: "d".repeat(64) };
  const preflight = { claude: { bin: claude.realpath, version: claude.version, sha256: claude.sha256 }, plugins: [], cleanup: { ok: true },
    scenarios: Object.fromEntries(SCENARIOS.map(s => [s.id, { ok: true }])) };
  const slots = models.flatMap((model, i) => scenarios.map(scenario => {
    const input = makeSlot(t, scenario.id, model);
    input.evidence.facts.preflight = structuredClone(preflight);
    const slot = { ...input, ...evaluateStoredSlot(input), durationMs: 1200, cleanup: { ok: true, bridges: [{ ok: true }] } };
    slot.evidence.settings = { ok: true, files: [{ before: "c".repeat(64), after: "c".repeat(64) }] };
    assert.equal(slot.outcome, "pass", `${model} ${scenario.id}: ${slot.reason}`);
    if (mixed && i % 3 !== 0) {
      slot.outcome = i % 3 === 1 ? "fail" : "blocked";
      slot.reason = slot.outcome === "fail" ? "confirmed scenario violation" : "SDK evidence unavailable";
      slot.checks.push({ name: "synthetic required behavior", ok: false, outcome: slot.outcome, detail: "missing observed behavior" });
    }
    return slot;
  }));
  const summary = {
    ...createRunDefinition(models, scenarios), actualTotal: slots.length, mode: "live", claude, preflight,
    copilotSdk: { version: "0.0.0-recorded" }, node: "v0.0.0-recorded",
    host: { platform: "fixture-platform", arch: "fixture-arch", release: "fixture-release" },
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:03.000Z", durationSeconds: 3,
    execution: { modelConcurrency: 3, pendingToolWaitMs: 30000, timeouts: { scale: 2, bridgeHealthMs: 234567,
      cleanupMs: 12345, scenarioMs: Object.fromEntries(scenarios.map(s => [s.id, 612345])) } },
    userSettings: { path: "fixture-settings.json", intact: true, before: "missing", after: "missing" }, cleanup: { ok: true },
    provenance: { start: structuredClone(state), end: structuredClone(state),
      sources: { path: "sources/manifest.json", sha256: sha(fs.readFileSync(path.join(dir, "sources/manifest.json"))) } },
  };
  fs.mkdirSync(path.join(dir, "slots"));
  json(path.join(dir, "slots/raw-evidence.json"), slots.map(s => s.evidence.facts));
  const run = { dir, summary, slots };
  save(run);
  return run;
}

const inputs = (run) => ["summary.json", "slots.jsonl"].map((file) => fs.readFileSync(path.join(run.dir, file)));

test("three-model focused fixture preserves mixed outcomes and phase evidence in every language", (t) => {
  const run = makeRun(t);
  const before = inputs(run);
  for (const format of FORMATS) {
    const output = renderReport(loadRun(run.dir), format);
    assert.match(output, /(?:result|결과): NOT PASSED/);
    assert.match(output, /pass 1 \/ fail 1 \/ blocked 1 \/ unknown 0/);
    assert.match(output, /(?:expected|예상): 3.*(?:actual|실제): 3.*gate: 3/);
    for (let i = 0; i < 3; i++) {
      assert.ok(output.includes(`| ${PRIMARY_MODELS[i]} | ${["PASS", "FAIL", "BLOCKED"][i]} |`));
      for (const phase of SCENARIOS[0].phases) {
        assert.ok(output.includes(`| ${PRIMARY_MODELS[i]} / ${ID} | ${phase.id} | PASS | ${PRIMARY_MODELS[i]} | ${PRIMARY_MODELS[i]} |`));
      }
    }
    assert.match(output, /confirmed scenario violation|SDK evidence unavailable/);
    assert.match(output, /synthetic required behavior: missing observed behavior/);
    assert.ok(output.includes(`V01 r${SCENARIOS[0].revision}`));
    assert.match(output, format.lang === "ko" ? /브리지 요청 이름/ : /Bridge requested labels/);
    assert.doesNotMatch(output, /CLI requested labels|CLI 요청 이름|\| SDK check \||\| SDK 검사 \|/);
    assert.doesNotMatch(output, /weighted|coverage|verify:probe|VERIFICATION_HISTORY|v11-|Chrome|scenario-concurrency/);
    assert.doesNotMatch(output, /[ \t]+$/m);
  }
  assert.deepEqual(inputs(run), before);
});

test("36 complete cases pass, while focused success is explicitly not full success", (t) => {
  const full = makeRun(t, { models: PRIMARY_MODELS, scenarios: SCENARIOS, mixed: false });
  const focused = makeRun(t, { models: PRIMARY_MODELS.slice(0, 1), mixed: false });
  for (const format of FORMATS) {
    const loaded = loadRun(full.dir);
    assert.deepEqual(loaded.integrityProblems, []);
    const output = renderReport(loaded, format);
    assert.match(output, /(?:result|결과): PASS\n/);
    assert.match(output, /pass 36 \/ fail 0 \/ blocked 0/);
    assert.match(output, /(?:scope|범위): full/);
    const subset = renderReport(focused, format);
    assert.match(subset, /(?:result|결과): FOCUSED PASS/);
    assert.match(subset, format.lang === "ko" ? /전체 매트릭스 통과가 아닙니다/ : /not a full-matrix pass/);
  }
});

test("missing, duplicate, unexpected and unknown results never become a pass", (t) => {
  const run = makeRun(t, { models: PRIMARY_MODELS.slice(0, 1), mixed: false });
  const original = run.slots[0];
  for (const slots of [[], [original, original], [{ ...original, model: "unexpected" }], [{ ...original, outcome: "unknown" }], [null]]) {
    run.slots = slots;
    run.summary.actualTotal = slots.length;
    for (const format of FORMATS) {
      const output = renderReport(run, format);
      assert.match(output, /(?:result|결과): NOT PASSED/);
      assert.match(output, /(?:expected|예상): 1/);
      if (slots.length === 2) assert.match(output, /DUPLICATE/);
    }
  }
});

test("reports display only canonical SDK evidence, never CLI labels or retired evidence as served proof", (t) => {
  const run = makeRun(t, { models: PRIMARY_MODELS.slice(0, 1) });
  run.slots[0].evidence.servedModels = ["retired-evidence-do-not-use"];
  run.slots[0].evidence.phases.unicode = { requestedModels: ["requested-only"], servedModels: ["wrong-level-do-not-use"] };
  delete run.slots[0].evidence.phases.clear;
  for (const format of FORMATS) {
    const output = renderReport(run, format);
    assert.match(output, /\| unicode \| UNKNOWN \| requested-only \| unknown \|/);
    assert.match(output, /\| clear \| UNKNOWN \| unknown \| unknown \|/);
    assert.doesNotMatch(output, /retired-evidence-do-not-use|wrong-level-do-not-use/);
  }
});

test("recorded versions and waits never come from current dependencies or report environment", (t) => {
  const run = makeRun(t);
  const initial = renderReport(run);
  for (const format of FORMATS) {
    const output = renderReport(run, format);
    for (const expected of ["0.0.0-recorded", "v0.0.0-recorded", "bridgeHealthMs: 234567", `scenarioMs.${ID}: 612345`, "--timeout-scale: 2", "--model-concurrency: 3", "PENDING_TOOL_WAIT_MS: 30000", "b".repeat(40), run.summary.provenance.start.fingerprint.value]) {
      assert.ok(output.includes(expected), expected);
    }
  }
  delete run.summary.copilotSdk;
  const withoutSdk = renderReport(run);
  assert.match(withoutSdk, /Copilot SDK \(@github\/copilot-sdk\) package version: unknown; npm package version recorded when the run started, not the Copilot runtime binary identity/);
  const omitSdk = (output) => output.split("\n").filter((line) => !line.startsWith("Copilot SDK (")).join("\n");
  assert.equal(omitSdk(initial), omitSdk(withoutSdk));
  delete run.summary.execution;
  delete run.summary.claude;
  delete run.summary.node;
  for (const format of FORMATS) {
    const output = renderReport(run, format);
    assert.match(output, /--timeout-scale: unknown/);
    assert.match(output, /PENDING_TOOL_WAIT_MS: unknown/);
    assert.match(output, /bridgeHealthMs: unknown/);
    assert.doesNotMatch(output, /PENDING_TOOL_WAIT_MS=|CLAUDE_CODE_BIN=/);
  }
});

test("missing provenance/settings/expected metadata fails closed without inventing evidence", (t) => {
  const run = makeRun(t, { mixed: false });
  const original = structuredClone(run.summary);
  for (const field of ["provenance", "userSettings", "expectedSlots", "actualTotal"]) {
    run.summary = structuredClone(original);
    delete run.summary[field];
    assert.match(renderReport(run), /result: NOT PASSED/);
  }
  run.summary = {};
  assert.match(renderReport(run), /result: UNVERIFIED/);
  assert.match(renderReport(run), /Expected model selection: unknown/);
  assert.match(renderReport(run), /Checklist text: unknown/);
});

test("changed code and settings invalidate an otherwise all-pass model table", (t) => {
  const run = makeRun(t, { mixed: false });
  for (const mutate of [
    (s) => { s.userSettings.after = "present:" + "c".repeat(64); },
    (s) => { s.provenance.end.fingerprint.value = "c".repeat(64); },
    (s) => { s.provenance.end.git.commit = "c".repeat(40); },
  ]) {
    const summary = structuredClone(run.summary);
    mutate(summary);
    for (const format of FORMATS) assert.match(renderReport({ ...run, summary }, format), /(?:result|결과): NOT PASSED/);
  }
});

test("reproduction separates free preview, paid rerun and explicit shell-safe run paths", (t) => {
  const run = makeRun(t);
  const output = renderReport(run);
  assert.match(output, /Preview only: no binary\/authentication\/connectivity checks/);
  assert.match(output, /Optional new live run: consumes real Copilot usage/);
  assert.match(output, /commit alone cannot reconstruct the code that ran/);
  assert.match(output, /frozen working-tree source copies/);
  assert.match(output, /re-evaluates each saved PASS slot's stored raw evidence with the current checkout's evaluator/);
  assert.match(output, /Frozen source copies \(sources\/files\/\) are reproduction material: the reporter checks their hashes and never executes them/);
  assert.match(renderReport(run, { markdown: true, lang: "ko" }), /동결된 소스 사본\(sources\/files\/\)은 재현 자료이며 리포터는 해시만 검사하고 실행하지 않습니다/);
  const commands = output.split("\n").filter((line) => line.startsWith("CLAUDE_CODE_BIN="));
  assert.equal(commands.length, 2);
  assert.equal(commands[0], commands[1] + " --dry-run");
  assert.match(commands[1], /PENDING_TOOL_WAIT_MS='30000'.*--model-concurrency '3'.*--timeout-scale '2'.*--models '/);
  const argument = output.split("\n").find((line) => line.startsWith("node scripts/verify/report.mjs ")).slice("node scripts/verify/report.mjs ".length);
  const decoded = execFileSync("/bin/sh", ["-c", `printf '%s' ${argument}`], { encoding: "utf8", timeout: 1000 });
  assert.equal(decoded, run.dir);
  assert.ok(output.includes(`npm run verify:doc -- ${argument}`));
});

test("rerun commands repeat every recorded runtime budget that differs from its default", (t) => {
  const run = makeRun(t);
  const recorded = { ...runtimeTimeouts({}), pendingToolWaitMs: 30000, turnTimeoutMs: 600000, stateIdleTtlMs: 7200000 };
  run.summary.execution.runtimeTimeouts = recorded;
  for (const format of FORMATS) {
    const commands = renderReport(run, format).split("\n").filter((line) => line.startsWith("CLAUDE_CODE_BIN="));
    assert.equal(commands.length, 2);
    assert.equal(commands[0], commands[1] + " --dry-run");
    assert.match(commands[1], /PENDING_TOOL_WAIT_MS='30000' TURN_IDLE_TIMEOUT_MS='600000' STATE_IDLE_TTL_MS='7200000' npm run verify /);
    assert.doesNotMatch(commands[1], /TURN_MAX_DURATION_MS|SESSION_OPERATION_TIMEOUT_MS|CLEANUP_TIMEOUT_MS/);
    // The emitted names are the ones the bridge reads: they reproduce the recorded budgets exactly.
    const env = Object.fromEntries([...commands[1].matchAll(/\b([A-Z_]+)='(\d+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(runtimeTimeouts(env), recorded);
  }
  run.summary.execution.runtimeTimeouts = { ...runtimeTimeouts({}), pendingToolWaitMs: 30000, abortTimeoutMs: 9000, mcpDiscoveryTimeoutMs: 9000 };
  const live = renderReport(run).split("\n").filter((line) => line.startsWith("CLAUDE_CODE_BIN="))[1];
  assert.match(live, /PENDING_TOOL_WAIT_MS='30000' npm run verify /);
  assert.equal(live.match(/PENDING_TOOL_WAIT_MS=/g).length, 1);
});

test("cleanup metadata shows each CLI exit and bridge stop receipt, never a bare cleanup boolean", (t) => {
  const run = makeRun(t, { models: [PRIMARY_MODELS[2]], scenarios: [scenario("V03")], mixed: false });
  const slot = run.slots[0];
  slot.evidence.facts.launches = [{ ok: true, pid: 101, exitCode: 1, signal: null, groupGone: true, forced: true, escalated: false, reason: "deadline" },
    { ok: false, pid: 102, helperPid: 103, helperGone: false, groupGone: true, exitCode: null, signal: "SIGKILL", forced: true, escalated: true, remainingPids: [104] }];
  Object.assign(slot, evaluateStoredSlot(slot));
  assert.equal(slot.outcome, "fail");
  assert.equal(slot.checks.find((c) => c.name === "CLI cleanup").ok, false);
  slot.cleanup = { ok: false, bridges: [{ ok: false, pid: 9, groupGone: true, portReleased: false, code: null, signal: "SIGTERM" }] };
  run.summary.execution.runtimeTimeouts = runtimeTimeouts({});
  const health = { ok: true, instanceId: "verify-fixture", modelCount: 23, capabilities: { unsupportedNativeControls: ["temperature"] }, timeouts: runtimeTimeouts({}) };
  slot.bridges = [{ pid: 9, port: 4567, health, logPath: path.join(run.dir, "slots/fixture/bridge.log") },
    { pid: 10, port: 4568, health: { ...health, timeouts: { ...health.timeouts, turnTimeoutMs: 1 } }, logPath: path.join(run.dir, "slots/fixture/bridge-2.log") }];
  run.slots.push({ slotId: "blocked", model: PRIMARY_MODELS[2], scenario: "V03", outcome: "blocked", reason: "Preflight unavailable", durationMs: 0,
    checks: [{ name: "slot available", ok: false, outcome: "blocked", detail: "Preflight unavailable" }], cleanup: { ok: true, bridges: [] }, evidence: { phases: {} } });
  for (const format of FORMATS) {
    const output = renderReport(run, format), ko = format.lang === "ko";
    assert.doesNotMatch(output, /CLI cleanup (?:true|false|unknown)|bridge cleanup (?:true|false|unknown)|capabilities|unsupportedNativeControls/);
    for (const expected of ko ? [
      "CLI 1: PID 101; 종료 코드 1; 시그널 없음; 강제 종료 예; SIGKILL 승격 아니오; 회수 예 (그룹 종료 예; 남은 PID unknown); 사유 deadline",
      "CLI 2: PID 102; 종료 코드 없음; 시그널 SIGKILL; 강제 종료 예; SIGKILL 승격 예; 회수 아니오 (그룹 종료 예; 헬퍼 종료 아니오; 남은 PID 104)",
      "브리지 정지 1: PID 9; 그룹 종료 예; 포트 해제 아니오; 종료 코드 없음; 시그널 SIGTERM",
      "브리지 1 /health: ok 예; instance verify-fixture; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 예; PID 9; port 4567; 전체 기록 slots.jsonl bridges[0].health; 로그 slots/fixture/bridge.log",
      "브리지 2 /health: ok 예; instance verify-fixture; 모델 수 23; 타임아웃이 기록된 런타임 값과 일치 아니오; PID 10",
      "V03: seconds 0.0\n  CLI 시작 안 됨\n  브리지 시작 안 됨\n",
    ] : [
      "CLI 1: PID 101; exit code 1; signal none; forced yes; escalated to SIGKILL no; reaped yes (group gone yes; remaining PIDs unknown); reason deadline",
      "CLI 2: PID 102; exit code none; signal SIGKILL; forced yes; escalated to SIGKILL yes; reaped no (group gone yes; helper gone no; remaining PIDs 104)",
      "bridge stop 1: PID 9; group gone yes; port released no; exit code none; signal SIGTERM",
      "bridge 1 /health: ok yes; instance verify-fixture; models 23; timeouts match recorded runtime yes; PID 9; port 4567; full record slots.jsonl bridges[0].health; log slots/fixture/bridge.log",
      "bridge 2 /health: ok yes; instance verify-fixture; models 23; timeouts match recorded runtime no; PID 10",
      "V03: seconds 0.0\n  CLI not started\n  bridge not started\n",
    ]) assert.ok(output.includes(expected), expected);
  }
});

test("effort cells name each recorded model-state condition and never fill in a value", (t) => {
  const run = makeRun(t, { models: ["claude-haiku-4.5", "claude-opus-5.5"], scenarios: [scenario("V04")], mixed: false });
  const target = run.slots[0].evidence.phases.target, [state] = target.modelStates;
  assert.equal(state.appliedEffort, null);
  const cases = [
    [[state], "not requested / not applied / not reported by SDK", "요청 없음 / 적용 없음 / SDK 미보고"],
    [[{ ...state, current: { modelId: "claude-haiku-4.5" } }], "not requested / not applied / not reported by SDK", "요청 없음 / 적용 없음 / SDK 미보고"],
    [[{ ...state, ok: false, current: null, error: "timeout" }], "not requested / not applied / observation failed (timeout)", "요청 없음 / 적용 없음 / 관측 실패 (timeout)"],
    [[{ current: {} }], "unknown / unknown / unknown", "unknown / unknown / unknown"],
    [[], "no model state", "모델 상태 없음"],
  ];
  for (const format of FORMATS) {
    const ko = format.lang === "ko";
    for (const [states, en, kr] of cases) {
      target.modelStates = states;
      const output = renderReport(run, format);
      assert.ok(output.includes(`| claude-haiku-4.5 / V04 | target | PASS | claude-haiku-4.5 | claude-haiku-4.5 | ${ko ? kr : en} |`), ko ? kr : en);
      assert.ok(output.includes("| claude-opus-5.5 / V04 | target | PASS | claude-opus-5.5 | claude-opus-5.5 | high / high / high |"));
      assert.match(output, ko ? /"SDK 미보고"는 SDK 모델 상태에 reasoningEffort가 없었음을/ : /"not reported by SDK" means the SDK model state omitted reasoningEffort/);
    }
  }
});

test("Markdown names no home directory or per-user temp root, and its commands stay copy-pasteable", { skip: !path.isAbsolute(os.homedir()) || os.homedir() === "/" }, (t) => {
  const run = makeRun(t, { models: PRIMARY_MODELS.slice(0, 1), mixed: false });
  const home = os.homedir(), tmp = fs.realpathSync(os.tmpdir()), encoded = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
  const slot = run.slots[0], phase = slot.evidence.phases.unicode;
  run.summary.claude.realpath = run.summary.claude.bin = path.join(home, ".local/share/claude/versions/fixture");
  run.summary.userSettings.path = path.join(home, ".claude", "settings.json");
  phase.transcriptPath = path.join(run.dir, "slots/fixture__V01/home/.claude/projects", `${encoded(tmp)}-verify-essential-Q1-workspace`, "session.jsonl");
  phase.sdk.logRange = { path: path.join(run.dir, "slots/fixture__V01/bridge.log"), start: 3, end: 9 };
  slot.checks.push({ name: "synthetic path check", ok: false, detail: `ENOENT ${path.join(home, "private-note")}; ${path.join(tmp, "verify-essential-Q1", "workspace")}; cwd ${tmp}; projects/${encoded(tmp)}/x; projects/${encoded(home)}-x` });
  for (const format of FORMATS) {
    const output = renderReport(run, format);
    assert.ok(output.includes("log range slots/fixture__V01/bridge.log bytes 3-9"));
    assert.match(output, /transcript slots\/fixture__V01\/home\/\.claude\/projects\/\S+-verify-essential-Q1-workspace\/session\.jsonl;/);
    if (!format.markdown) continue;
    assert.ok(!output.includes(home) && !output.includes(encoded(home)), "home directory leaked");
    assert.doesNotMatch(output, /\/var\/folders\/|-var-folders-/);
    for (const expected of ["user settings: ~/.claude/settings.json;", "ENOENT ~/private-note;", "projects/-HOME-x"]) assert.ok(output.includes(expected), expected);
    const lines = output.split("\n"), decode = (value) => execFileSync("/bin/sh", ["-c", `printf '%s' ${value}`], { encoding: "utf8", timeout: 1000, env: { ...process.env, HOME: home } });
    const bins = lines.filter((line) => line.startsWith("CLAUDE_CODE_BIN=")).map((line) => line.split(" ")[0].slice("CLAUDE_CODE_BIN=".length));
    assert.deepEqual(bins, ['"$HOME/.local/share/claude/versions/fixture"', '"$HOME/.local/share/claude/versions/fixture"']);
    assert.equal(decode(bins[0]), run.summary.claude.realpath);
    const argument = lines.find((line) => line.startsWith("node scripts/verify/report.mjs ")).slice("node scripts/verify/report.mjs ".length);
    assert.equal(fs.realpathSync(decode(argument)), run.dir);
  }
});

test("result, matrix and failure reasons come before criteria and long metadata in both languages", (t) => {
  const run = makeRun(t);
  const order = [["result: ", "결과: "], ["Model × scenario results", "모델 × 시나리오 결과"], ["- FAIL ", "- FAIL "], ["Scenario criteria", "시나리오 기준"],
    ["Phase evidence", "단계별 증거"], ["Run metadata", "실행 메타데이터"], ["Evidence and reproduction", "증거와 재현"], ["Limits", "한계"]];
  for (const format of FORMATS) {
    const lines = renderReport(run, format).split("\n").map((line) => line.replace(/^## /, ""));
    const at = order.map(([en, ko]) => { const want = format.lang === "ko" ? ko : en; return lines.findIndex((line) => want.endsWith(" ") ? line.startsWith(want) : line === want); });
    assert.ok(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])), JSON.stringify(at));
  }
});

test("English and Korean documents carry the same structure, values and commands", (t) => {
  const run = makeRun(t);
  run.slots[1].evidence.facts.launches[0].exitCode = 1;
  const [en, ko] = ["en", "ko"].map((lang) => renderReport(loadRun(run.dir), { markdown: true, lang }).split("\n"));
  assert.equal(en.length, ko.length);
  const kind = (line) => /^(?:#+ |\| |```|> |- |  CLI |  bridge |  브리지 |\s+- )/.exec(line)?.[0].replace("브리지", "bridge") ?? "";
  // Checklist sentences are scenario definitions (scenarios.mjs), rendered verbatim rather than by the reporter.
  const criteria = new Set(run.summary.scenarios.flatMap((s) => s.pass.map((text) => `  - ${text}`)));
  for (let i = 0; i < en.length; i++) {
    assert.equal(kind(ko[i]), kind(en[i]), `line ${i + 1}: ${en[i]}`);
    if (!criteria.has(en[i])) assert.deepEqual(ko[i].match(/\d+/g), en[i].match(/\d+/g), `line ${i + 1}: ${en[i]}`);
    if (en[i - 1] === "```bash") assert.equal(ko[i], en[i]);
  }
});

test("CLI reads caller-relative input and prints a path valid from repository root without SDK resolution", (t) => {
  const run = makeRun(t);
  const cwd = path.join(ROOT, "docs");
  const guard = `
    import Module from 'node:module';
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...args) {
      if (request === '@github/copilot-sdk') throw new Error('UNEXPECTED_SDK_RESOLUTION');
      return original.call(this, request, ...args);
    };
    globalThis.fetch = () => { throw new Error('UNEXPECTED_NETWORK'); };
  `;
  const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(guard)}`, REPORT, path.relative(cwd, run.dir)], {
    cwd, encoding: "utf8", timeout: 10000, env: { ...process.env, PENDING_TOOL_WAIT_MS: "654321" },
  });
  assert.ok(output.includes(`node scripts/verify/report.mjs '${run.dir.replaceAll("'", "'\\''")}'`));
  assert.doesNotMatch(output, /654321|UNEXPECTED_/);
  const repositoryRun = { ...run, dir: path.join(ROOT, "synthetic run's directory") };
  assert.ok(renderReport(repositoryRun).includes("node scripts/verify/report.mjs 'synthetic run'\\''s directory'"));
});

test("report CLI requires exactly one explicit input and rejects unknown flags/languages", () => {
  for (const args of [[], ["--write-docs"], ["--markdown"], [""], ["one", "two"], ["one", "--markdown=xx"], ["one", "--unknown"], ["one", "--write-docs", "--markdown"]]) {
    assert.throws(() => parseReportArgs(args));
  }
  assert.deepEqual(parseReportArgs(["--write-docs", "run dir"]), { dir: "run dir", markdown: false, lang: "en", write: true });
  const result = spawnSync(process.execPath, [REPORT], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit run directory/);
});

test("document generation renders both languages before replacing existing files", (t) => {
  const run = makeRun(t);
  const docsDir = path.join(path.dirname(run.dir), "docs");
  fs.mkdirSync(docsDir);
  const names = ["VERIFICATION.md", "VERIFICATION_KO.md"];
  for (const name of names) fs.writeFileSync(path.join(docsDir, name), `original ${name}`);
  const before = names.map((name) => fs.readFileSync(path.join(docsDir, name), "utf8"));
  const unchanged = () => assert.deepEqual(names.map((name) => fs.readFileSync(path.join(docsDir, name), "utf8")), before);
  for (const input of [undefined, "", path.join(run.dir, "absent"), docsDir]) {
    assert.throws(() => writeDocs(input, { docsDir }));
    unchanged();
  }
  fs.writeFileSync(path.join(run.dir, "slots.jsonl"), "{incomplete\n");
  assert.throws(() => writeDocs(run.dir, { docsDir }), /Invalid slots/);
  unchanged();
  save(run);
  assert.throws(() => writeDocs(run.dir, { docsDir, render: (r, options) => {
    unchanged();
    if (options.lang === "ko") throw new Error("Korean rendering failed");
    return renderReport(r, options);
  } }), /Korean rendering failed/);
  unchanged();
  assert.throws(() => writeDocs(run.dir, { docsDir, render: () => "" }), /nonempty/);
  unchanged();
  const outputs = writeDocs(run.dir, { docsDir });
  assert.deepEqual(outputs, names.map((name) => path.join(docsDir, name)));
  for (const [i, lang] of ["en", "ko"].entries()) {
    assert.equal(fs.readFileSync(outputs[i], "utf8"), renderReport(loadRun(run.dir), { markdown: true, lang }));
  }
  assert.deepEqual(fs.readdirSync(docsDir).sort(), names.sort());
});

test("document generation refuses symlink destinations before replacing either language", (t) => {
  const run = makeRun(t);
  const docsDir = path.join(path.dirname(run.dir), "docs");
  fs.mkdirSync(docsDir);
  const first = path.join(docsDir, "VERIFICATION.md");
  const external = path.join(path.dirname(run.dir), "untouched.txt");
  fs.writeFileSync(first, "original English");
  fs.writeFileSync(external, "untouched");
  fs.symlinkSync(external, path.join(docsDir, "VERIFICATION_KO.md"));
  assert.throws(() => writeDocs(run.dir, { docsDir }), /Not a regular document/);
  assert.equal(fs.readFileSync(first, "utf8"), "original English");
  assert.equal(fs.readFileSync(external, "utf8"), "untouched");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRIMARY_MODELS, SCENARIOS } from "../scripts/verify/scenarios.mjs";
import { coverage } from "../scripts/verify/features.mjs";

const REPORT = fileURLToPath(new URL("../scripts/verify/report.mjs", import.meta.url));
const FORMATS = ["terminal", "--markdown", "--markdown=ko"];
const MODEL = PRIMARY_MODELS[0];
const SELECTED = [SCENARIOS[0], SCENARIOS[3], SCENARIOS.find((s) => s.id.startsWith("v11-"))];

function executionFixture() {
  return {
    modelConcurrency: 7,
    scenarioConcurrency: 2,
    pendingToolWaitMs: 30000,
    timeouts: {
      scale: 2,
      bridgeHealthMs: 240000,
      planTurnMs: 180000,
      backgroundLaunchMs: 240000,
      foregroundLaunchMs: 360000,
      persistentLaunchMs: 240000,
      detachedOutputMs: 480000,
      // Distinct recorded values expose any recomputation from today's catalogue.
      scenarioMs: Object.fromEntries(SCENARIOS.map((s, i) => [s.id, 480000 + i * 1000])),
    },
  };
}

function writeSummary(run) {
  fs.writeFileSync(path.join(run.dir, "summary.json"), JSON.stringify(run.summary));
}

function makeRun(t, execution) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-report-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const slots = [
    { model: MODEL, scenario: SELECTED[0].id, outcome: "pass", checks: [{ name: "file exists", ok: true }] },
    {
      model: MODEL, scenario: SELECTED[1].id, outcome: "fail",
      checks: [{ name: "disk evidence", ok: false, detail: "missing expected file" }],
    },
    { model: MODEL, scenario: SELECTED[2].id, outcome: "blocked", reason: "fixture transport stopped" },
  ];
  const summary = {
    models: [MODEL],
    scenarios: SELECTED.map((s) => ({ id: s.id })),
    claude: { bin: "offline-fixture", version: "offline-fixture" },
    durationSeconds: 3,
    gate: 3,
    green: false,
    userSettings: { path: "offline-fixture-settings.json", intact: false },
  };
  if (execution !== undefined) summary.execution = execution;
  const run = { dir, summary, slots };
  writeSummary(run);
  fs.writeFileSync(path.join(dir, "slots.jsonl"), slots.map((s) => JSON.stringify(s)).join("\n") + "\n");
  return run;
}

function render(run, format) {
  return execFileSync(process.execPath, [REPORT, run.dir, ...(format === "terminal" ? [] : [format])], {
    cwd: run.dir,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PENDING_TOOL_WAIT_MS: "654321" },
  });
}

function assertRecorded(output, key, value) {
  assert.ok(
    output.includes(`${key}: ${value} —`) || output.includes(`\`${key}\` | ${value} |`),
    `missing recorded setting ${key} = ${value}`,
  );
}

function resultsAndEvidence(output, format) {
  if (format === "terminal") {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.trim() === MODEL);
    assert.notEqual(start, -1, "matrix header exists");
    return lines.slice(start).join("\n");
  }
  const headings = format === "--markdown=ko"
    ? ["## 결과 매트릭스\n", "## 재현\n"]
    : ["## Results\n", "## Reproducing\n"];
  const start = output.indexOf(headings[0]);
  const end = output.indexOf(headings[1]);
  assert.ok(start >= 0 && end > start, "result and reproduction headings exist");
  return output.slice(start, end);
}

test("reports recorded timing and concurrency in terminal and both document languages", (t) => {
  const execution = executionFixture();
  const run = makeRun(t, execution);
  const command = "PENDING_TOOL_WAIT_MS=30000 npm run verify -- --timeout-scale 2 " +
    `--model-concurrency 7 --scenario-concurrency 2 --models ${MODEL} ` +
    `--scenarios ${SELECTED.map((s) => s.id).join(",")}`;

  for (const format of FORMATS) {
    const output = render(run, format);
    assertRecorded(output, "--timeout-scale", 2);
    assertRecorded(output, "PENDING_TOOL_WAIT_MS", "30000 ms (30 s)");
    assertRecorded(output, "--model-concurrency", 7);
    assertRecorded(output, "--scenario-concurrency", 2);
    for (const [key, value] of Object.entries(execution.timeouts)) {
      if (key !== "scale" && key !== "scenarioMs") {
        assertRecorded(output, key, `${value} ms (${value / 1000} s)`);
      }
    }
    for (const [id, value] of Object.entries(execution.timeouts.scenarioMs)) {
      assertRecorded(output, `scenarioMs.${id}`, `${value} ms (${value / 1000} s)`);
    }
    const turnLine = output.split("\n").find((line) => line.includes(`scenarioMs.${SELECTED[0].id}`));
    const launcherLine = output.split("\n").find((line) => line.includes(`scenarioMs.${SELECTED[2].id}`));
    assert.match(turnLine, format === "--markdown=ko" ? /Claude Code 실행 1회마다/ : /Each Claude Code invocation in the scenario/);
    assert.match(launcherLine, format === "--markdown=ko" ? /쓰지 않음/ : /Not used/);
    assert.match(output, format === "--markdown=ko" ? /하네스 대기 시간에만 곱합니다/ : /multiplies only the harness waits/);
    assert.match(output, format === "--markdown=ko"
      ? /`PENDING_TOOL_WAIT_MS`, 하네스의 고정 대기/
      : /does not scale `PENDING_TOOL_WAIT_MS`, the harness's fixed waits/);
    assert.match(output, format === "--markdown=ko" ? /기본값 10000 ms/ : /Default 10000 ms/);
    assert.ok(output.includes(command));
    if (format !== "terminal") {
      assert.ok(output.includes(`${command} --dry-run`));
      const settings = output.indexOf(format === "--markdown=ko" ? "### 이 실행의 설정\n" : "### Settings this run used\n");
      const reproduce = output.indexOf(format === "--markdown=ko" ? "## 재현\n" : "## Reproducing\n");
      assert.ok(reproduce >= 0 && settings > reproduce, "the settings table sits under Reproducing");
      assert.ok(output.indexOf("`PENDING_TOOL_WAIT_MS=30000`") < reproduce, "the lead names the bridge setting");
      assert.match(output, format === "--markdown=ko"
        ? /\*\*기본 `PENDING_TOOL_WAIT_MS` 값\.\*\* .*최대 30000 ms.*기본값은 10000 ms/
        : /\*\*The default `PENDING_TOOL_WAIT_MS`\.\*\* .*up to 30000 ms.*The default is 10000 ms/);
    }
    assert.doesNotMatch(output, /654321/);
  }
});

test("older summaries retain identical matrix, tally, gate, coverage and failure evidence", (t) => {
  const run = makeRun(t, executionFixture());
  const recorded = new Map(FORMATS.map((format) => [format, render(run, format)]));
  delete run.summary.execution;
  writeSummary(run);

  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, format === "--markdown=ko" ? /기록 없음/ : /[Nn]ot recorded/);
    assert.doesNotMatch(output, /--timeout-scale|--model-concurrency|--scenario-concurrency|PENDING_TOOL_WAIT_MS=/);
    assert.equal(resultsAndEvidence(output, format), resultsAndEvidence(recorded.get(format), format));
    assert.ok(output.includes(format === "terminal"
      ? "pass 1  fail 1  blocked 1  of 3   (gate: 3)"
      : "**pass 1 / fail 1 / blocked 1**"));
    assert.match(output, /missing expected file/);
    assert.match(output, /fixture transport stopped/);
    if (format !== "terminal") {
      assert.match(output, format === "--markdown=ko" ? /위 집계와 무관하게/ : /not green regardless of the tally/);
    }
  }
});

test("partial execution metadata is not completed from defaults or the report environment", (t) => {
  const run = makeRun(t, { modelConcurrency: 3, timeouts: { scale: 1.5, bridgeHealthMs: 12345 } });
  for (const format of FORMATS) {
    const output = render(run, format);
    const missing = format === "--markdown=ko" ? "기록 없음" : "not recorded";
    assertRecorded(output, "--timeout-scale", 1.5);
    assertRecorded(output, "--model-concurrency", 3);
    assertRecorded(output, "--scenario-concurrency", missing);
    assertRecorded(output, "PENDING_TOOL_WAIT_MS", missing);
    assertRecorded(output, "bridgeHealthMs", "12345 ms (12.345 s)");
    assertRecorded(output, "planTurnMs", missing);
    const command = output.split("\n").find((line) => line.startsWith("reproduce:") || line.startsWith("npm run verify --"));
    assert.ok(command);
    assert.match(command, /--timeout-scale 1\.5 --model-concurrency 3/);
    assert.doesNotMatch(command, /PENDING_TOOL_WAIT_MS|--scenario-concurrency/);
    assert.doesNotMatch(output, /The default `PENDING_TOOL_WAIT_MS`|기본 `PENDING_TOOL_WAIT_MS` 값/);
    assert.doesNotMatch(output, /654321/);
  }
});

test("Markdown reports remove trailing whitespace without changing recorded evidence", (t) => {
  const run = makeRun(t, executionFixture());
  run.slots[1].checks[0].detail = "first evidence  \nsecond evidence\t\nlast evidence";
  run.slots[1].reason = "first reason  \nsecond reason\t\nlast reason  ";
  const slotsFile = path.join(run.dir, "slots.jsonl");
  const recorded = run.slots.map((s) => JSON.stringify(s)).join("\n") + "\n";
  fs.writeFileSync(slotsFile, recorded);

  for (const format of ["--markdown", "--markdown=ko"]) {
    const output = render(run, format);
    assert.doesNotMatch(output, /[ \t]+$/m);
    assert.match(output, /first evidence\nsecond evidence\nlast evidence/);
    assert.match(output, /first reason\nsecond reason\nlast reason/);
    assert.equal(fs.readFileSync(slotsFile, "utf8"), recorded);
  }
});

function saveRun(run) {
  writeSummary(run);
  fs.writeFileSync(path.join(run.dir, "slots.jsonl"), run.slots.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

async function makeStrictRun(t, models = PRIMARY_MODELS, scenarios = SCENARIOS) {
  const { createRunDefinition } = await import("../scripts/verify/summary.mjs");
  const run = makeRun(t, executionFixture());
  const state = {
    git: { commit: "b".repeat(40), dirty: true },
    fingerprint: { algorithm: "sha256", scope: "verification-code-v1", value: "a".repeat(64), files: 12 },
  };
  run.slots = models.flatMap((model) => scenarios.map((s) => ({ model, scenario: s.id, outcome: "pass" })));
  run.summary = {
    ...run.summary, ...createRunDefinition(models, scenarios), actualTotal: run.slots.length,
    userSettings: { path: "offline-settings.json", intact: true, before: "missing", after: "missing" },
    provenance: { start: state, end: structuredClone(state) },
  };
  saveRun(run);
  return run;
}

test("all renderers preserve a legacy 74 gate and stored green without claiming strict success", (t) => {
  const run = makeRun(t);
  run.summary.gate = 74;
  run.summary.green = true;
  run.summary.models = [...PRIMARY_MODELS];
  run.summary.scenarios = SCENARIOS.map((s) => ({ id: s.id }));
  run.summary.userSettings = { intact: true };
  run.slots = PRIMARY_MODELS.flatMap((model) => SCENARIOS.map((s) => ({ model, scenario: s.id, outcome: "pass" })));
  for (let i = 0; i < 3; i += 1) run.slots[i].outcome = "blocked";
  saveRun(run);
  const before = fs.readFileSync(path.join(run.dir, "summary.json"), "utf8");
  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, /legacy/i);
    assert.match(output, /(?:gate: |gate |통과 기준 )74/);
    assert.match(output, /(?:stored green|저장된 green): true/);
    assert.match(output, format === "--markdown=ko" ? /엄격한 전체 통과.*아닙니다/ : /not.*strict all-pass/i);
    assert.doesNotMatch(output, /result: PASS|결과: PASS/);
  }
  assert.equal(fs.readFileSync(path.join(run.dir, "summary.json"), "utf8"), before);
});

test("all renderers show strict 66 of 66 success and recorded code provenance", async (t) => {
  const run = await makeStrictRun(t);
  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, /strict-all-pass-v1/);
    assert.match(output, /(?:scope|범위): full/);
    assert.match(output, /(?:expected|예상): 66.*(?:actual|실제): 66/);
    assert.match(output, /(?:result|결과): PASS/);
    assert.ok(output.includes("b".repeat(40)));
    assert.ok(output.includes("a".repeat(64)));
    assert.match(output, /dirty: true/);
    assertRecorded(output, "--timeout-scale", 2);
  }
  run.slots.slice(0, 3).forEach((s) => { s.outcome = "blocked"; });
  saveRun(run);
  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, /(?:result|결과): NOT GREEN/);
    assert.match(output, /(?:gate: |gate |통과 기준 )66/);
    assert.match(output, /pass 63/);
  }
});

test("focused reports retain selected coverage and cannot be described as full-matrix success", async (t) => {
  const run = await makeStrictRun(t, [MODEL], [SCENARIOS[0]]);
  run.summary.coverage = coverage(SCENARIOS); // Stale full-catalogue metadata must not leak into focused coverage.
  saveRun(run);
  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, /(?:scope|범위): focused/);
    assert.match(output, /(?:expected|예상): 1.*(?:actual|실제): 1/);
    assert.match(output, /(?:result|결과): PASS/);
    assert.ok(output.includes(`${coverage([SCENARIOS[0]]).percent}%`));
    assert.match(output, format === "--markdown=ko" ? /통과율이 아/ : /not a pass rate/);
    assert.match(output, format === "--markdown=ko" ? /전체 매트릭스.*아/ : /not a full-matrix/);
  }
});

test("reports fail closed for missing, duplicate, unexpected, unknown and empty rows", async (t) => {
  const run = await makeStrictRun(t, [MODEL], [SCENARIOS[0]]);
  const slot = run.slots[0];
  for (const rows of [[], [slot, slot], [{ ...slot, scenario: "unexpected" }], [{ ...slot, outcome: "unknown" }], [null]]) {
    run.slots = rows;
    run.summary.actualTotal = rows.length;
    saveRun(run);
    for (const format of FORMATS) {
      const output = render(run, format);
      assert.match(output, /(?:result|결과): NOT GREEN/);
      assert.match(output, /(?:expected|예상): 1/);
      if (rows.length === 2) assert.match(output, /DUP/);
    }
  }
});

test("reports never invent provenance or a success verdict from missing metadata", async (t) => {
  const run = await makeStrictRun(t, [MODEL], [SCENARIOS[0]]);
  for (const field of ["provenance", "userSettings", "expectedSlots", "actualTotal"]) {
    const saved = run.summary[field];
    delete run.summary[field];
    saveRun(run);
    for (const format of FORMATS) assert.match(render(run, format), /(?:result|결과): NOT GREEN/);
    run.summary[field] = saved;
  }
  run.summary = {};
  saveRun(run);
  for (const format of FORMATS) {
    const output = render(run, format);
    assert.match(output, /(?:result|결과): UNVERIFIED/);
    assert.match(output, format === "--markdown=ko" ? /기록 없음/ : /not recorded/i);
    assert.doesNotMatch(output, /(?:gate: |gate |통과 기준 )1(?:[).\n]|$)/);
  }
});

test("all-pass reports are not green when settings or implementation changed", async (t) => {
  const run = await makeStrictRun(t, [MODEL], [SCENARIOS[0]]);
  const baseline = structuredClone(run.summary);
  for (const alter of [
    (s) => { s.userSettings.after = "present:" + "c".repeat(64); },
    (s) => { s.provenance.end.fingerprint.value = "d".repeat(64); },
    (s) => { s.provenance.end.git.commit = "e".repeat(40); },
  ]) {
    run.summary = structuredClone(baseline);
    alter(run.summary);
    saveRun(run);
    for (const format of FORMATS) assert.match(render(run, format), /(?:result|결과): NOT GREEN/);
  }
});

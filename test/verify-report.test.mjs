import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PRIMARY_MODELS, SCENARIOS, gateFor } from "../scripts/verify/scenarios.mjs";

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
    assert.match(turnLine, format === "--markdown=ko" ? /슬롯 전체가 아닌 headless 턴마다/ : /Per headless turn, not per slot/);
    assert.match(launcherLine, format === "--markdown=ko" ? /계획용 값만/ : /Planning only/);
    assert.match(output, format === "--markdown=ko" ? /확립된 해결책이 아닙니다/ : /not an established fix for no-result exits/);
    assert.match(output, format === "--markdown=ko" ? /실제 최악의 경우 상한이 아닙니다/ : /not deadlines or true worst-case bounds/);
    assert.match(output, /Status\/list\/stop\/final-cleanup/);
    assert.ok(output.includes(command));
    if (format !== "terminal") assert.ok(output.includes(`${command} --dry-run`));
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
      ? `pass 1  fail 1  blocked 1  of 3   (gate: ${gateFor(3)})`
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

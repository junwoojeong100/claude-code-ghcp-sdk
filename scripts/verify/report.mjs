#!/usr/bin/env node
/**
 * Turn a run directory into something a person can read.
 *
 * Two audiences, one source: `--markdown` writes the document that ships in
 * docs/, everything else prints to a terminal. Both are generated from
 * slots.jsonl, so neither can drift from what actually ran.
 *
 * Usage:
 *   node scripts/verify/report.mjs                      # newest run
 *   node scripts/verify/report.mjs .verify-runs/<id>
 *   node scripts/verify/report.mjs --markdown    > docs/VERIFICATION.md
 *   node scripts/verify/report.mjs --markdown=ko > docs/VERIFICATION_KO.md
 */

import fs from "node:fs";
import path from "node:path";

import { ABSENT_TOOLS, FEATURES, coverage } from "./features.mjs";
import { SCENARIOS, PRIMARY_MODELS } from "./scenarios.mjs";
import { assessRun, slotKey } from "./summary.mjs";

const RUNS_DIR = ".verify-runs";

function newestRun() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const entries = fs
    .readdirSync(RUNS_DIR)
    .map((name) => path.join(RUNS_DIR, name))
    .filter((p) => fs.existsSync(path.join(p, "slots.jsonl")))
    .sort();
  return entries.at(-1) ?? null;
}

function loadRun(dir) {
  const slots = fs
    .readFileSync(path.join(dir, "slots.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const summaryPath = path.join(dir, "summary.json");
  const summary = fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, "utf8"))
    : {};
  return { dir, slots, summary, assessment: assessRun(summary, slots) };
}

const MARK = { pass: "PASS", fail: "FAIL", blocked: "BLOCK", duplicate: "DUP" };
const CELL = { pass: "O", fail: "X", blocked: "!", duplicate: "DUP" };

function matrix(slots, models, scenarios) {
  const byKey = new Map();
  for (const slot of slots) {
    if (!slot || typeof slot.model !== "string" || typeof slot.scenario !== "string") continue;
    const key = slotKey(slot);
    // A second record is not a replacement for the first. Never hide a duplicate
    // (or an earlier failure) behind the last row's pass mark.
    byKey.set(key, byKey.has(key) ? { outcome: "duplicate" } : slot);
  }
  return { byKey, models, scenarios };
}

function cell(slot) {
  if (!slot) return "-";
  return Object.hasOwn(CELL, slot.outcome) ? CELL[slot.outcome] : "?";
}

/**
 * Row and column order for both reports.
 *
 * The catalogue order the run recorded, so a slot that happened to finish
 * first cannot reorder the shipped document. Falls back to completion order
 * only for a run whose summary predates that record.
 */
function axes(run) {
  const { slots, summary } = run;
  const strings = (values) => [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
  const recordedModels = strings(Array.isArray(summary.models) ? summary.models : []);
  const recorded = strings(Array.isArray(summary.scenarios) ? summary.scenarios.map((s) => s?.id ?? s) : []);
  const models = recordedModels.length ? recordedModels : strings(slots.map((s) => s?.model));
  const scenarioIds = recorded.length ? recorded : strings(slots.map((s) => s?.scenario));
  // Display fallbacks only: assessRun never uses observed rows as expected axes.
  return { models, scenarioIds };
}

/**
 * Coverage, recomputed from the current catalogue over the scenarios this run
 * recorded.
 *
 * The summary carries a coverage object frozen when the run finished, and it
 * is the one part of the record that must not be read back. Coverage is a
 * property of the catalogue -- the feature inventory crossed with each
 * scenario's `covers` list -- not of the run, so correcting the inventory
 * leaves every older frozen copy asserting something false. It did: runs from
 * before `probe.mjs` measured Glob and Grep absent still count both as
 * covered, on a build that offers neither.
 *
 * The scenario set still comes from the record. This is selected-scenario
 * catalogue coverage, not a pass rate or proof that all selected slots ran.
 */
function coverageFor(run) {
  const { scenarioIds } = axes(run);
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const ran = scenarioIds.map((id) => byId.get(id)).filter(Boolean);
  if (ran.length !== scenarioIds.length) {
    const missing = scenarioIds.filter((id) => !byId.has(id));
    console.error(`warning: run records scenarios absent from the catalogue: ${missing.join(", ")}`);
  }
  return coverage(ran);
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** All formats display the same pure assessment; no renderer invents a gate. */
function assessmentLines(run, t) {
  const a = run.assessment;
  const lines = [
    `${t.policyLabel}: ${a.policyKind === "legacy" ? t.legacyPolicy : a.policy?.id ?? t.notRecorded}`,
    `${t.scopeLabel}: ${a.scope.kind} (${a.scope.fullMatrixTotal ?? t.notRecorded} ${t.fullMatrixSlots})`,
    `${t.expectedLabel}: ${a.expectedTotal ?? t.notRecorded} / ${t.actualLabel}: ${a.actualTotal}`,
    `${t.resultLabel}: ${a.policyKind === "legacy" ? "UNVERIFIED" : a.green ? "PASS" : "NOT GREEN"}`,
  ];
  if (a.policyKind === "legacy") {
    lines.push(`${t.storedGreenLabel}: ${a.storedGreen ?? t.notRecorded}`, t.legacyNote);
  } else {
    lines.push(t.strictNote);
  }
  if (a.scope.kind === "focused") lines.push(t.focusedNote);
  if (a.counts.unknown) lines.push(`${t.unknownLabel}: ${a.counts.unknown}`);
  for (const problem of a.problems) lines.push(`${t.problemLabel}: ${problem}`);
  for (const [label, entries] of [
    [t.missingLabel, a.missingSlots], [t.duplicateLabel, a.duplicateSlots],
    [t.unexpectedLabel, a.unexpectedSlots], [t.unknownLabel, a.unknownOutcomes],
  ]) {
    for (const slot of entries) {
      lines.push(`${label}: ${slot.model ?? "?"} × ${slot.scenario ?? "?"}` +
        (Object.hasOwn(slot, "outcome") ? ` (${String(slot.outcome)})` : ""));
    }
  }
  return lines;
}

function provenanceLines(summary, t) {
  return ["start", "end"].map((phase) => {
    const state = summary.provenance?.[phase];
    const fingerprint = state?.fingerprint;
    return `${t.provenanceLabel} ${phase}: commit: ${state?.git?.commit ?? t.notRecorded}; ` +
      `dirty: ${state?.git?.dirty ?? t.notRecorded}; ` +
      `fingerprint: ${fingerprint?.algorithm ?? t.notRecorded} ${fingerprint?.scope ?? t.notRecorded} ` +
      `${fingerprint?.value ?? t.notRecorded}; files: ${fingerprint?.files ?? t.notRecorded}`;
  });
}

function milliseconds(value, t) {
  return value == null ? t.notRecorded : `${value} ms (${value / 1000} s)`;
}

/** Display the run's configured waits, never today's defaults or a recalculated scale. */
function executionRows(summary, t) {
  const execution = summary.execution;
  const timeouts = execution.timeouts ?? {};
  const rows = [
    ["--timeout-scale", timeouts.scale ?? t.notRecorded, t.scaleScope],
    ["PENDING_TOOL_WAIT_MS", milliseconds(execution.pendingToolWaitMs, t), t.pendingScope],
    ["--model-concurrency", execution.modelConcurrency ?? t.notRecorded, t.modelScope],
    ["--scenario-concurrency", execution.scenarioConcurrency ?? t.notRecorded, t.scenarioScope],
  ];
  for (const [key, scope] of Object.entries(t.stepScopes)) {
    rows.push([key, milliseconds(timeouts[key], t), scope]);
  }
  for (const [id, value] of Object.entries(timeouts.scenarioMs ?? {})) {
    rows.push([
      `scenarioMs.${id}`,
      milliseconds(value, t),
      id.startsWith("v11-") ? t.planningScope : t.turnScope,
    ]);
  }
  return rows;
}

function shellArgument(value) {
  const text = String(value);
  return /^[\w.,:/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function verificationCommand(run, dryRun = false) {
  const execution = run.summary.execution;
  const { models, scenarioIds } = axes(run);
  const flags = [];
  for (const [flag, value] of [
    ["--timeout-scale", execution?.timeouts?.scale],
    ["--model-concurrency", execution?.modelConcurrency],
    ["--scenario-concurrency", execution?.scenarioConcurrency],
  ]) {
    if (value != null) flags.push(flag, shellArgument(value));
  }
  if (models.join(",") !== PRIMARY_MODELS.join(",")) {
    flags.push("--models", shellArgument(models.join(",")));
  }
  if (scenarioIds.join(",") !== SCENARIOS.map((s) => s.id).join(",")) {
    flags.push("--scenarios", shellArgument(scenarioIds.join(",")));
  }
  if (dryRun) flags.push("--dry-run");
  const prefix = execution?.pendingToolWaitMs == null
    ? ""
    : `PENDING_TOOL_WAIT_MS=${shellArgument(execution.pendingToolWaitMs)} `;
  return `${prefix}npm run verify${flags.length ? ` -- ${flags.join(" ")}` : ""}`;
}

/* ------------------------------------------------------------------ *
 * terminal
 * ------------------------------------------------------------------ */

function printTerminal(run) {
  const { slots, summary } = run;
  const { models, scenarioIds } = axes(run);
  const { byKey } = matrix(slots, models, scenarioIds);

  const t = COPY.en;
  const { counts, gate } = run.assessment;
  const total = run.assessment.policyKind === "strict" ? run.assessment.expectedTotal ?? slots.length : slots.length;

  console.log(`run:      ${run.dir}`);
  console.log(`claude:   ${summary.claude?.bin ?? "?"} (${summary.claude?.version ?? "?"})`);
  const summaryCoverage = coverageFor(run);
  if (summaryCoverage) {
    const c = summaryCoverage;
    console.log(`coverage: ${c.percent}% weighted (${c.coveredWeight}/${c.totalWeight})`);
    if (c.missed?.length) console.log(`remainder: ${c.missed.join(", ")}`);
    if (c.unavailable?.length) {
      console.log(
        `absent:    ${c.unavailable.map((u) => `${u.id} (needs ${u.requiresTool})`).join(", ")}`,
      );
    }
  }
  console.log("");

  for (const line of assessmentLines(run, t)) console.log(line);
  for (const line of provenanceLines(summary, t)) console.log(line);
  console.log(t.coverageNote);
  console.log("");

  if (summary.execution) {
    console.log(`${t.executionHeading}:`);
    for (const [key, value, scope] of executionRows(summary, t)) {
      console.log(`  ${key}: ${value} — ${scope}`);
    }
    for (const note of t.executionNotes) console.log(note);
    console.log(`reproduce: ${verificationCommand(run)}`);
  } else {
    console.log(`execution: ${t.executionMissing}`);
  }
  console.log("");

  const nameWidth = Math.max(1, ...scenarioIds.map((id) => id.length)) + 1;
  const colWidth = Math.max(3, ...models.map((m) => m.length)) + 1;
  console.log(pad("", nameWidth) + models.map((m) => pad(m, colWidth)).join(""));
  for (const id of scenarioIds) {
    const row = models
      .map((model) => pad(cell(byKey.get(slotKey({ model, scenario: id }))), colWidth))
      .join("");
    console.log(pad(id, nameWidth) + row);
  }

  console.log("");
  console.log(
    `pass ${counts.pass}  fail ${counts.fail}  blocked ${counts.blocked}  of ${total}   (gate: ${gate ?? t.notRecorded})`,
  );

  if (summary.userSettings?.intact === false) console.log(t.settingsTouched(summary.userSettings.path));
  const bad = slots.filter((s) => s?.outcome !== "pass");
  if (bad.length) {
    console.log("");
    for (const slot of bad) {
      const mark = slot && Object.hasOwn(MARK, slot.outcome) ? MARK[slot.outcome] : "UNKNOWN";
      console.log(`${mark}  ${slot?.model ?? "?"}  ${slot?.scenario ?? "?"}`);
      const checks = Array.isArray(slot?.checks) ? slot.checks : [];
      for (const check of checks) {
        if (!check?.ok) console.log(`      - ${check?.name}: ${String(check?.detail).slice(0, 160)}`);
      }
      if (slot?.reason && !checks.some((c) => !c?.ok)) {
        console.log(`      - ${String(slot.reason).slice(0, 200)}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * markdown
 * ------------------------------------------------------------------ */

/**
 * Wording for the two documents that ship in docs/.
 *
 * Both are rendered from the same run, so the English and the Korean file can
 * differ in phrasing but never in what they report.
 */
const COPY = {
  en: {
    title: (models, scenarios) =>
      `Verification — ${models} models × ${scenarios} scenarios`,
    generated:
      "Generated by `scripts/verify/report.mjs` from a run's own record (`slots.jsonl`). " +
      "Do not edit by hand; regenerating overwrites it.",
    whatHeading: "What was verified",
    whatBody:
      "Every slot runs the real path end to end: the real Claude Code binary -> the bridge -> the Copilot SDK -> a Copilot model. " +
      "Nothing is mocked. Each slot is judged on **files on disk, git history, hook logs and stream-json events**, " +
      "never on what the model said about its own work.",
    ranAt: "Ran",
    took: "Took",
    host: "Host",
    assessmentHeading: "Policy, completeness and provenance",
    policyLabel: "policy",
    legacyPolicy: "legacy stored policy",
    scopeLabel: "scope",
    fullMatrixSlots: "full-matrix catalogue slots",
    expectedLabel: "expected",
    actualLabel: "actual",
    resultLabel: "result",
    storedGreenLabel: "stored green",
    legacyNote: "A legacy stored gate/green is not a strict all-pass verdict. Missing policy or provenance is not inferred.",
    strictNote: "Strict success requires a nonempty, exact, unique expected matrix, all pass outcomes, unchanged user settings and matching start/end code provenance.",
    focusedNote: "Focused success applies only to the selected matrix; it is not a full-matrix success.",
    unknownLabel: "unknown outcomes",
    problemLabel: "diagnostic",
    missingLabel: "missing slot",
    duplicateLabel: "duplicate slot",
    unexpectedLabel: "unexpected slot",
    provenanceLabel: "provenance",
    coverageNote: "Selected-scenario catalogue coverage, not a pass rate or proof of complete execution.",
    executionHeading: "Recorded execution settings",
    executionMissing: "Not recorded; timeout, pending-tool wait and concurrency values are not inferred.",
    notRecorded: "not recorded",
    settingColumn: "Setting / wait",
    recordedColumn: "Recorded value",
    scopeColumn: "Applies to",
    scaleScope: "Verification-only timeout multiplier",
    pendingScope: "Independent pending-tool wait; not multiplied by --timeout-scale",
    modelScope: "Concurrent model workers",
    scenarioScope: "Concurrent scenario workers per model",
    stepScopes: {
      bridgeHealthMs: "Verification bridge health wait",
      planTurnMs: "Each plan-mode headless turn",
      backgroundLaunchMs: "v11 background launcher invocation",
      foregroundLaunchMs: "v11 foreground launcher invocation",
      persistentLaunchMs: "v11 persistent launcher invocation",
      detachedOutputMs: "v11 detached output wait",
    },
    turnScope: "Per headless turn, not per slot (v01–v10)",
    planningScope: "Planning only; v11 uses the independent step waits above",
    executionNotes: [
      "Status/list/stop/final-cleanup wrappers, polls/probes, the local-test limit, SIGKILL grace, and operational launcher/daemon startup defaults remain unchanged by the timeout scale.",
      "A command-scoped PENDING_TOOL_WAIT_MS=30000 (30 s) is a verification precaution, not an established fix for no-result exits.",
      "Single-turn schedule estimates are for planning, not deadlines or true worst-case bounds: a slot can contain multiple invocations, and v11 uses independent step waits rather than its scenarioMs planning budget.",
    ],
    matrixHeading: "Results",
    scenarioColumn: "Scenario",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}** — ${total} slots, gate ${gate}.`,
    blockedNote:
      "BLOCK (blocked) is not a pass. The slot could not be exercised, so it stays in the denominator. DUP marks duplicate records; UNKNOWN marks an unrecognized outcome.",
    settingsTouched: (settingsPath) =>
      `🚨 **This run is not green regardless of the tally above**: \`${settingsPath}\` changed while it ran. ` +
      "Every slot is handed its own `--settings` file and its own `CLAUDE_CONFIG_DIR`, so nothing here may touch the real one.",
    scenariosHeading: "Scenarios",
    bridgeRiskLabel: "**Bridge defect this scenario is built to catch**",
    passLabel: "Judged on:",
    coverageHeading: "Coverage",
    coverageBody: (c, scenarios) =>
      `The ${scenarios} selected scenarios map to **${c.percent}%** of the current Claude Code core-feature inventory (weight ${c.coveredWeight}/${c.totalWeight}). ` +
      "This is catalogue coverage, not a pass rate or proof of complete execution. " +
      "It is computed from `scripts/verify/features.mjs` and each selected scenario's `covers` list, independently of the result tally.",
    missedHeading: "Not covered (the honest remainder)",
    absentHeading: "Tools this build does not offer (excluded from the denominator)",
    absentBody: (version, tools) =>
      `Claude Code ${version} does not provide ${tools}. ` +
      "Measured by `scripts/verify/probe.mjs`, which instructs a session to call each one by name and reads the stream: " +
      "a tool the build does not offer can never produce a tool_use block, however firmly it is asked for. " +
      "Read runs in the same turn as a positive control, so a model that declines wholesale is distinguishable from a tool that is genuinely missing. " +
      "That is the CLI's boundary rather than a bridge defect, so they count neither as covered nor as missed and leave the denominator entirely.",
    weight: "weight",
    needs: "needs",
    failuresHeading: "Slots that did not pass",
    reproduceHeading: "Reproducing",
    reproduceRecorded:
      "These commands reuse the recorded settings. Any unrecorded settings still use current defaults, not reconstructed historical values.",
    reproduceMissing:
      "Execution settings were not recorded. These commands select the recorded matrix but use current timing and concurrency defaults; they do not reproduce the original execution settings.",
    reproduce: (command, plan, models, scenarios) => [
      `${command} # ${models} models × ${scenarios} scenarios`,
      `${plan} # plan only, no model calls`,
      "npm run verify:probe        # capability probes behind the absent-tool list",
      "npm run verify:report       # summarise the most recent run",
    ],
  },
  ko: {
    title: (models, scenarios) => `검증 결과 — ${models}개 모델 × ${scenarios}개 시나리오`,
    generated:
      "이 문서는 `scripts/verify/report.mjs`가 실행 기록(`slots.jsonl`)에서 생성합니다. " +
      "손으로 고치지 마세요 — 다시 생성하면 덮어쓰입니다.",
    whatHeading: "무엇을 검증했나",
    whatBody:
      "모든 슬롯은 실제 경로를 그대로 지납니다: 진짜 Claude Code 바이너리 → 브리지 → Copilot SDK → Copilot 모델. " +
      "목이나 스텁은 없습니다. 판정은 모델이 무엇을 말했는지가 아니라 " +
      "**디스크 상태, git 이력, 훅 로그, stream-json 이벤트**로 합니다.",
    ranAt: "실행 시각",
    took: "소요",
    host: "호스트",
    assessmentHeading: "정책, 완전성 및 코드 출처",
    policyLabel: "정책",
    legacyPolicy: "legacy 저장 정책",
    scopeLabel: "범위",
    fullMatrixSlots: "전체 매트릭스 카탈로그 슬롯",
    expectedLabel: "예상",
    actualLabel: "실제",
    resultLabel: "결과",
    storedGreenLabel: "저장된 green",
    legacyNote: "과거에 저장된 gate/green은 엄격한 전체 통과 판정이 아닙니다. 없는 정책이나 코드 출처 기록을 추정하지 않습니다.",
    strictNote: "엄격한 통과는 비어 있지 않은 예상 매트릭스의 정확하고 중복 없는 완료, 모든 슬롯의 pass, 사용자 설정 보존 및 시작/종료 코드 출처 일치를 요구합니다.",
    focusedNote: "부분 검증의 통과는 선택한 매트릭스에만 적용되며 전체 매트릭스의 통과가 아닙니다.",
    unknownLabel: "알 수 없는 결과",
    problemLabel: "진단",
    missingLabel: "누락 슬롯",
    duplicateLabel: "중복 슬롯",
    unexpectedLabel: "예상 밖 슬롯",
    provenanceLabel: "코드 출처",
    coverageNote: "선택한 시나리오의 카탈로그 커버리지이며 통과율이 아니고 모든 슬롯 실행의 증거도 아닙니다.",
    executionHeading: "기록된 실행 설정",
    executionMissing: "기록 없음. timeout, pending-tool 대기, 동시성 값을 추정하지 않습니다.",
    notRecorded: "기록 없음",
    settingColumn: "설정 / 대기",
    recordedColumn: "기록된 값",
    scopeColumn: "적용 범위",
    scaleScope: "검증 전용 timeout 배율",
    pendingScope: "별도의 pending-tool 대기. --timeout-scale을 곱하지 않음",
    modelScope: "동시에 실행할 모델 작업자 수",
    scenarioScope: "모델별로 동시에 실행할 시나리오 작업자 수",
    stepScopes: {
      bridgeHealthMs: "검증용 bridge health 대기",
      planTurnMs: "plan-mode의 각 headless 턴",
      backgroundLaunchMs: "v11 background launcher 호출",
      foregroundLaunchMs: "v11 foreground launcher 호출",
      persistentLaunchMs: "v11 persistent launcher 호출",
      detachedOutputMs: "v11 detached 출력 대기",
    },
    turnScope: "슬롯 전체가 아닌 headless 턴마다 적용 (v01–v10)",
    planningScope: "계획용 값만 기록. v11은 위의 별도 단계별 대기를 사용",
    executionNotes: [
      "Status/list/stop/final-cleanup wrapper, poll/probe, 로컬 테스트 제한, SIGKILL 유예 시간과 실제 운용 launcher/daemon 시작 기본값은 timeout 배율로 바뀌지 않습니다.",
      "명령 한정 PENDING_TOOL_WAIT_MS=30000(30초)은 검증 시의 예방 조치이지, 결과 없이 종료되는 현상의 확립된 해결책이 아닙니다.",
      "단일 턴 기준 일정 추정치는 계획용이며 deadline이나 실제 최악의 경우 상한이 아닙니다. 한 슬롯에 여러 호출이 있을 수 있고, v11은 scenarioMs 계획 예산이 아닌 별도의 단계별 대기를 사용합니다.",
    ],
    matrixHeading: "결과 매트릭스",
    scenarioColumn: "시나리오",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}** — 전체 ${total}슬롯, 통과 기준 ${gate}.`,
    blockedNote:
      "BLOCK(blocked)는 통과가 아닙니다. 실행하지 못한 슬롯이며 분모에 그대로 남습니다. DUP는 중복 기록, UNKNOWN은 알 수 없는 결과입니다.",
    settingsTouched: (settingsPath) =>
      `🚨 **위 집계와 무관하게 이 실행은 통과가 아닙니다**: 실행 도중 \`${settingsPath}\`가 변경되었습니다. ` +
      "모든 슬롯은 전용 `--settings` 파일과 전용 `CLAUDE_CONFIG_DIR`를 받으므로, 실제 사용자 설정을 건드려서는 안 됩니다.",
    scenariosHeading: "시나리오",
    bridgeRiskLabel: "**이 시나리오가 잡아내려는 브리지 결함**",
    passLabel: "판정 기준:",
    coverageHeading: "커버리지",
    coverageBody: (c, scenarios) =>
      `선택한 ${scenarios}개 시나리오는 현재 Claude Code 핵심 기능 인벤토리의 **${c.percent}%**(가중치 ${c.coveredWeight}/${c.totalWeight})에 해당합니다. ` +
      "이는 카탈로그 커버리지이며 통과율이 아니고 모든 슬롯 실행의 증거도 아닙니다. " +
      "결과 집계와 별도로 `scripts/verify/features.mjs`의 기능 목록과 선택한 각 시나리오의 `covers`에서 계산됩니다.",
    missedHeading: "커버하지 못한 기능 (정직한 잔여분)",
    absentHeading: "이 빌드에 없는 도구 (분모에서 제외)",
    absentBody: (version, tools) =>
      `Claude Code ${version}는 다음 도구를 제공하지 않습니다: ${tools}. ` +
      "`scripts/verify/probe.mjs`가 측정합니다. 각 도구를 이름으로 지목해 호출시키고 스트림을 읽습니다 — " +
      "빌드가 제공하지 않는 도구는 아무리 강하게 요구해도 tool_use 블록을 만들 수 없기 때문입니다. " +
      "같은 턴에서 Read를 양성 대조군으로 함께 호출시키므로, 모델이 통째로 거부한 경우와 도구가 실제로 없는 경우를 구분할 수 있습니다. " +
      "브리지의 결함이 아니라 CLI가 애초에 제공하지 않는 기능이므로, " +
      "커버한 것으로도 못 한 것으로도 세지 않고 분모에서 제외합니다.",
    weight: "가중치",
    needs: "필요",
    failuresHeading: "통과하지 못한 슬롯",
    reproduceHeading: "재현",
    reproduceRecorded:
      "아래 명령은 기록된 설정을 다시 사용합니다. 기록되지 않은 설정에는 과거 값을 추정하지 않고 현재 기본값을 적용합니다.",
    reproduceMissing:
      "실행 설정이 기록되지 않았습니다. 아래 명령은 기록된 매트릭스를 선택하지만 대기 시간과 동시성에는 현재 기본값을 사용하므로 원래 실행 설정을 재현하지는 못합니다.",
    reproduce: (command, plan, models, scenarios) => [
      `${command} # ${models}개 모델 × ${scenarios}개 시나리오`,
      `${plan} # 실행 없이 계획만`,
      "npm run verify:probe        # 없는 도구 목록의 근거가 되는 능력 프로브",
      "npm run verify:report       # 최근 실행 결과 요약",
    ],
  },
};

function printMarkdown(run, lang = "en") {
  const t = COPY[lang] ?? COPY.en;
  const ko = lang === "ko";
  const { slots, summary } = run;
  const { models, scenarioIds } = axes(run);
  const { byKey } = matrix(slots, models, scenarioIds);
  const { counts, gate } = run.assessment;
  const total = run.assessment.policyKind === "strict" ? run.assessment.expectedTotal ?? slots.length : slots.length;
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const c = coverageFor(run) ?? {};

  const out = [];
  out.push(`# ${t.title(models.length, scenarioIds.length)}`);
  out.push("");
  out.push(t.generated);
  out.push("");
  out.push(`## ${t.whatHeading}`);
  out.push("");
  out.push(t.whatBody);
  out.push("");
  out.push(`- Claude Code: \`${summary.claude?.version ?? "?"}\``);
  out.push(`- ${t.ranAt}: ${summary.startedAt ?? "?"} → ${summary.finishedAt ?? "?"}`);
  out.push(`- ${t.took}: ${summary.durationSeconds ?? "?"}${ko ? "초" : "s"}`);
  out.push(`- ${t.host}: ${summary.host?.platform ?? "?"} ${summary.host?.arch ?? ""} / node ${summary.node ?? "?"}`);
  out.push("");

  out.push(`## ${t.assessmentHeading}`);
  out.push("");
  for (const line of assessmentLines(run, t)) out.push(`- ${line}`);
  for (const line of provenanceLines(summary, t)) out.push(`- ${line}`);
  out.push("");

  out.push(`## ${t.executionHeading}`);
  out.push("");
  if (summary.execution) {
    out.push(`| ${t.settingColumn} | ${t.recordedColumn} | ${t.scopeColumn} |`);
    out.push("| --- | --- | --- |");
    for (const [key, value, scope] of executionRows(summary, t)) {
      out.push(`| \`${key}\` | ${value} | ${scope} |`);
    }
    out.push("");
    for (const note of t.executionNotes) out.push(note, "");
  } else {
    out.push(t.executionMissing, "");
  }

  out.push(`## ${t.matrixHeading}`);
  out.push("");
  out.push(`| ${t.scenarioColumn} | ${models.join(" | ")} |`);
  out.push(`| --- | ${models.map(() => "---").join(" | ")} |`);
  for (const id of scenarioIds) {
    const cells = models.map((model) => {
      const slot = byKey.get(slotKey({ model, scenario: id }));
      if (!slot) return "–";
      return Object.hasOwn(MARK, slot.outcome) ? MARK[slot.outcome] : "UNKNOWN";
    });
    out.push(`| \`${id}\` | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(t.tally(counts, total, gate ?? t.notRecorded));
  out.push("");
  out.push(t.blockedNote);
  out.push("");
  // A run that rewrote the machine it ran on is not green however the slots
  // landed, so the tally above must not be the last word on it.
  if (summary.userSettings && summary.userSettings.intact === false) {
    out.push(t.settingsTouched(summary.userSettings.path));
    out.push("");
  }

  out.push(`## ${t.scenariosHeading}`);
  out.push("");
  for (const id of scenarioIds) {
    const scenario = byId.get(id);
    if (!scenario) continue;
    out.push(`### \`${id}\` — ${ko ? scenario.nameKo : scenario.name}`);
    out.push("");
    out.push(ko ? scenario.intentKo : scenario.intent);
    out.push("");
    out.push(`${t.bridgeRiskLabel}: ${ko ? scenario.bridgeRiskKo : scenario.bridgeRisk}`);
    out.push("");
    out.push(t.passLabel);
    for (const line of scenario.pass) out.push(`- ${line}`);
    out.push("");
  }

  out.push(`## ${t.coverageHeading}`);
  out.push("");
  out.push(t.coverageBody(c, scenarioIds.length));
  out.push("");
  if (c.missed?.length) {
    out.push(`### ${t.missedHeading}`);
    out.push("");
    for (const id of c.missed) {
      const f = FEATURES.find((x) => x.id === id);
      out.push(`- \`${id}\` (${t.weight} ${f?.weight ?? "?"}) — ${(ko ? f?.nameKo : f?.name) ?? ""}`);
    }
    out.push("");
  }
  if (c.unavailable?.length) {
    out.push(`### ${t.absentHeading}`);
    out.push("");
    out.push(
      t.absentBody(summary.claude?.version ?? "", ABSENT_TOOLS.map((tool) => `\`${tool}\``).join(", ")),
    );
    out.push("");
    for (const u of c.unavailable) {
      const f = FEATURES.find((x) => x.id === u.id);
      out.push(
        `- \`${u.id}\` (${t.weight} ${u.weight}, \`${u.requiresTool}\` ${t.needs}) — ${(ko ? f?.nameKo : f?.name) ?? ""}`,
      );
    }
    out.push("");
  }

  const bad = slots.filter((s) => s?.outcome !== "pass");
  if (bad.length) {
    out.push(`## ${t.failuresHeading}`);
    out.push("");
    for (const slot of bad) {
      out.push(`### ${slot?.model ?? "?"} × \`${slot?.scenario ?? "?"}\` — ${slot?.outcome ?? "unknown"}`);
      out.push("");
      for (const check of Array.isArray(slot?.checks) ? slot.checks : []) {
        if (!check?.ok) out.push(`- FAIL ${check?.name} — \`${String(check?.detail).slice(0, 200)}\``);
      }
      if (slot?.reason) out.push(`- ${String(slot.reason).slice(0, 300)}`);
      out.push("");
    }
  }

  out.push(`## ${t.reproduceHeading}`);
  out.push("");
  out.push(summary.execution ? t.reproduceRecorded : t.reproduceMissing);
  out.push("");
  out.push("```bash");
  for (const line of t.reproduce(
    verificationCommand(run), verificationCommand(run, true), models.length, scenarioIds.length,
  )) out.push(line);
  out.push("```");
  out.push("");

  console.log(out.join("\n").replace(/[ \t]+$/gm, ""));
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const markdownArg = argv.find((a) => a === "--markdown" || a.startsWith("--markdown="));
const markdownLang = markdownArg?.split("=")[1] ?? "en";
const dir = argv.find((a) => !a.startsWith("--")) ?? newestRun();

if (!dir) {
  console.error("no run found under .verify-runs/");
  process.exit(1);
}
if (!fs.existsSync(path.join(dir, "slots.jsonl"))) {
  console.error(`not a run directory: ${dir}`);
  process.exit(1);
}

const run = loadRun(dir);
if (markdownArg) printMarkdown(run, markdownLang);
else printTerminal(run);

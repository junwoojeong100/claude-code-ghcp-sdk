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
import { SCENARIOS, PRIMARY_MODELS, gateFor } from "./scenarios.mjs";

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
  return { dir, slots, summary };
}

const MARK = { pass: "PASS", fail: "FAIL", blocked: "BLOCK" };
const CELL = { pass: "O", fail: "X", blocked: "!" };

function matrix(slots, models, scenarios) {
  const byKey = new Map(slots.map((s) => [`${s.model}::${s.scenario}`, s]));
  return { byKey, models, scenarios };
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
  const models = summary.models?.length ? summary.models : [...new Set(slots.map((s) => s.model))];
  const recorded = (summary.scenarios ?? []).map((s) => s.id ?? s).filter(Boolean);
  const scenarioIds = recorded.length ? recorded : [...new Set(slots.map((s) => s.scenario))];
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
 * The scenario set still comes from the record, so the fraction continues to
 * describe what actually ran.
 */
function coverageFor(run) {
  const { scenarioIds } = axes(run);
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const ran = scenarioIds.map((id) => byId.get(id)).filter(Boolean);
  if (ran.length !== scenarioIds.length) {
    const missing = scenarioIds.filter((id) => !byId.has(id));
    console.error(`warning: run records scenarios absent from the catalogue: ${missing.join(", ")}`);
  }
  return ran.length ? coverage(ran) : (run.summary.coverage ?? null);
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function tally(slots) {
  const counts = { pass: 0, fail: 0, blocked: 0 };
  for (const slot of slots) counts[slot.outcome] = (counts[slot.outcome] ?? 0) + 1;
  return counts;
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

  const counts = tally(slots);
  const gate = gateFor(slots.length);

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

  const t = COPY.en;
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

  const nameWidth = Math.max(...scenarioIds.map((id) => id.length)) + 1;
  const colWidth = Math.max(...models.map((m) => m.length)) + 1;
  console.log(pad("", nameWidth) + models.map((m) => pad(m, colWidth)).join(""));
  for (const id of scenarioIds) {
    const row = models
      .map((model) => pad(CELL[byKey.get(`${model}::${id}`)?.outcome] ?? "-", colWidth))
      .join("");
    console.log(pad(id, nameWidth) + row);
  }

  console.log("");
  console.log(
    `pass ${counts.pass}  fail ${counts.fail}  blocked ${counts.blocked}  of ${slots.length}   (gate: ${gate})`,
  );

  const bad = slots.filter((s) => s.outcome !== "pass");
  if (bad.length) {
    console.log("");
    for (const slot of bad) {
      console.log(`${MARK[slot.outcome]}  ${slot.model}  ${slot.scenario}`);
      for (const check of slot.checks ?? []) {
        if (!check.ok) console.log(`      - ${check.name}: ${String(check.detail).slice(0, 160)}`);
      }
      if (slot.reason && !(slot.checks ?? []).some((c) => !c.ok)) {
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
      "⚠️ (blocked) is not a pass. The transport broke, so the slot says nothing about the model — it stays in the denominator.",
    settingsTouched: (settingsPath) =>
      `🚨 **This run is not green regardless of the tally above**: \`${settingsPath}\` changed while it ran. ` +
      "Every slot is handed its own `--settings` file and its own `CLAUDE_CONFIG_DIR`, so nothing here may touch the real one.",
    scenariosHeading: "Scenarios",
    bridgeRiskLabel: "**Bridge defect this scenario is built to catch**",
    passLabel: "Judged on:",
    coverageHeading: "Coverage",
    coverageBody: (c, scenarios) =>
      `The ${scenarios} scenarios exercise **${c.percent}%** of the Claude Code core-feature inventory (weight ${c.coveredWeight}/${c.totalWeight}). ` +
      "That number is computed from the inventory in `scripts/verify/features.mjs` and each scenario's `covers` list, not asserted in prose.",
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
      "⚠️(blocked)는 통과가 아닙니다. 전송 계층이 깨져 모델에 대해 아무것도 말해주지 못한 슬롯이며, 분모에 그대로 남습니다.",
    settingsTouched: (settingsPath) =>
      `🚨 **위 집계와 무관하게 이 실행은 통과가 아닙니다**: 실행 도중 \`${settingsPath}\`가 변경되었습니다. ` +
      "모든 슬롯은 전용 `--settings` 파일과 전용 `CLAUDE_CONFIG_DIR`를 받으므로, 실제 사용자 설정을 건드려서는 안 됩니다.",
    scenariosHeading: "시나리오",
    bridgeRiskLabel: "**이 시나리오가 잡아내려는 브리지 결함**",
    passLabel: "판정 기준:",
    coverageHeading: "커버리지",
    coverageBody: (c, scenarios) =>
      `${scenarios}개 시나리오가 Claude Code 핵심 기능 인벤토리의 **${c.percent}%**(가중치 ${c.coveredWeight}/${c.totalWeight})를 실제로 행사합니다. ` +
      "이 숫자는 산문이 아니라 `scripts/verify/features.mjs`의 기능 목록과 각 시나리오의 `covers`에서 계산됩니다.",
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
  const counts = tally(slots);
  const gate = gateFor(slots.length);
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
      const slot = byKey.get(`${model}::${id}`);
      if (!slot) return "–";
      return { pass: "✅", fail: "❌", blocked: "⚠️" }[slot.outcome] ?? "–";
    });
    out.push(`| \`${id}\` | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(t.tally(counts, slots.length, gate));
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

  const bad = slots.filter((s) => s.outcome !== "pass");
  if (bad.length) {
    out.push(`## ${t.failuresHeading}`);
    out.push("");
    for (const slot of bad) {
      out.push(`### ${slot.model} × \`${slot.scenario}\` — ${slot.outcome}`);
      out.push("");
      for (const check of slot.checks ?? []) {
        if (!check.ok) out.push(`- ❌ ${check.name} — \`${String(check.detail).slice(0, 200)}\``);
      }
      if (slot.reason) out.push(`- ${String(slot.reason).slice(0, 300)}`);
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

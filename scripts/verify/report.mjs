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

import { ABSENT_TOOLS, FEATURES } from "./features.mjs";
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

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function tally(slots) {
  const counts = { pass: 0, fail: 0, blocked: 0 };
  for (const slot of slots) counts[slot.outcome] = (counts[slot.outcome] ?? 0) + 1;
  return counts;
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
  if (summary.coverage) {
    const c = summary.coverage;
    console.log(`coverage: ${c.percent}% weighted (${c.coveredWeight}/${c.totalWeight})`);
    if (c.missed?.length) console.log(`remainder: ${c.missed.join(", ")}`);
    if (c.unavailable?.length) {
      console.log(
        `absent:    ${c.unavailable.map((u) => `${u.id} (needs ${u.requiresTool})`).join(", ")}`,
      );
    }
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
    title: "Verification — seven models x ten scenarios",
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
    matrixHeading: "Results",
    scenarioColumn: "Scenario",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}** — ${total} slots, gate ${gate}.`,
    blockedNote:
      "⚠️ (blocked) is not a pass. The transport broke, so the slot says nothing about the model — it stays in the denominator.",
    scenariosHeading: "Scenarios",
    bridgeRiskLabel: "**Bridge defect this scenario is built to catch**",
    passLabel: "Judged on:",
    coverageHeading: "Coverage",
    coverageBody: (c) =>
      `The ten scenarios exercise **${c.percent}%** of the Claude Code core-feature inventory (weight ${c.coveredWeight}/${c.totalWeight}). ` +
      "That number is computed from the inventory in `scripts/verify/features.mjs` and each scenario's `covers` list, not asserted in prose.",
    missedHeading: "Not covered (the honest remainder)",
    absentHeading: "Tools this build does not offer (excluded from the denominator)",
    absentBody: (version, tools) =>
      `Claude Code ${version} does not provide ${tools}. ` +
      "This was measured by asking a model to call them directly; it answered that they are unavailable and reached for a workaround. " +
      "That is the CLI's boundary rather than a bridge defect, so they count neither as covered nor as missed and leave the denominator entirely.",
    weight: "weight",
    needs: "needs",
    failuresHeading: "Slots that did not pass",
    reproduceHeading: "Reproducing",
    reproduce: [
      "npm run verify              # 7 models x 10 scenarios",
      "npm run verify:plan         # plan only, no model calls",
      "npm run verify:report       # summarise the most recent run",
    ],
  },
  ko: {
    title: "검증 결과 — 7개 모델 × 10개 시나리오",
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
    matrixHeading: "결과 매트릭스",
    scenarioColumn: "시나리오",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}** — 전체 ${total}슬롯, 통과 기준 ${gate}.`,
    blockedNote:
      "⚠️(blocked)는 통과가 아닙니다. 전송 계층이 깨져 모델에 대해 아무것도 말해주지 못한 슬롯이며, 분모에 그대로 남습니다.",
    scenariosHeading: "시나리오",
    bridgeRiskLabel: "**이 시나리오가 잡아내려는 브리지 결함**",
    passLabel: "판정 기준:",
    coverageHeading: "커버리지",
    coverageBody: (c) =>
      `10개 시나리오가 Claude Code 핵심 기능 인벤토리의 **${c.percent}%**(가중치 ${c.coveredWeight}/${c.totalWeight})를 실제로 행사합니다. ` +
      "이 숫자는 산문이 아니라 `scripts/verify/features.mjs`의 기능 목록과 각 시나리오의 `covers`에서 계산됩니다.",
    missedHeading: "커버하지 못한 기능 (정직한 잔여분)",
    absentHeading: "이 빌드에 없는 도구 (분모에서 제외)",
    absentBody: (version, tools) =>
      `Claude Code ${version}는 다음 도구를 제공하지 않습니다: ${tools}. ` +
      "직접 호출을 시켜 확인했고, 모델이 \"없다\"고 답한 뒤 우회 수단을 택했습니다. " +
      "브리지의 결함이 아니라 CLI가 애초에 제공하지 않는 기능이므로, " +
      "커버한 것으로도 못 한 것으로도 세지 않고 분모에서 제외합니다.",
    weight: "가중치",
    needs: "필요",
    failuresHeading: "통과하지 못한 슬롯",
    reproduceHeading: "재현",
    reproduce: [
      "npm run verify              # 7개 모델 × 10개 시나리오",
      "npm run verify:plan         # 실행 없이 계획만",
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
  const c = summary.coverage ?? {};

  const out = [];
  out.push(`# ${t.title}`);
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
  out.push(t.coverageBody(c));
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
  out.push("```bash");
  for (const line of t.reproduce) out.push(line);
  out.push("```");
  out.push("");

  console.log(out.join("\n"));
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

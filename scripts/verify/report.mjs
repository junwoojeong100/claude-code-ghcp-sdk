#!/usr/bin/env node
/**
 * Turn a run directory into something a person can read.
 *
 * Two audiences, one source: `--markdown` writes the document that ships in
 * docs/, everything else prints to a terminal. Results, settings and the code
 * record come from the run (summary.json and slots.jsonl); scenario text and
 * the feature list come from the current scripts/verify/ sources.
 *
 * Usage:
 *   node scripts/verify/report.mjs                      # newest run
 *   node scripts/verify/report.mjs .verify-runs/<id>
 *   node scripts/verify/report.mjs --markdown    > docs/VERIFICATION.md
 *   node scripts/verify/report.mjs --markdown=ko > docs/VERIFICATION_KO.md
 */

import fs from "node:fs";
import path from "node:path";

import { ABSENT_TOOLS, ABSENT_TOOLS_MEASURED_ON, FEATURES, coverage } from "./features.mjs";
import { DECLARED_WITHOUT_CHECK, NOT_VERIFIED, SCENARIOS, PRIMARY_MODELS } from "./scenarios.mjs";
import { assessRun, slotKey } from "./summary.mjs";
import { readPendingToolWaitMs } from "./timeouts.mjs";

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

/** The bridge's own default, read from the same parser the harness records with. */
const DEFAULT_PENDING_TOOL_WAIT_MS = readPendingToolWaitMs({});

/** The one-word verdict every format shows; no renderer invents its own. */
function resultWord(a) {
  return a.policyKind === "legacy" ? "UNVERIFIED" : a.green ? "PASS" : "NOT GREEN";
}

/** All formats display the same pure assessment; no renderer invents a gate. */
function assessmentLines(run, t) {
  const a = run.assessment;
  const lines = [
    `${t.policyLabel}: ${a.policyKind === "legacy" ? t.legacyPolicy : a.policy?.id ?? t.notRecorded}`,
    `${t.scopeLabel}: ${a.scope.kind} (${t.fullMatrixSlots(a.scope.fullMatrixTotal ?? null)})`,
    `${t.expectedLabel}: ${a.expectedTotal ?? t.notRecorded} / ${t.actualLabel}: ${a.actualTotal}`,
    `${t.resultLabel}: ${resultWord(a)}`,
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

function codeState(state, t) {
  const fingerprint = state?.fingerprint;
  return `commit: ${state?.git?.commit ?? t.notRecorded}; ` +
    `dirty: ${state?.git?.dirty ?? t.notRecorded}; ` +
    `fingerprint: ${fingerprint?.algorithm ?? t.notRecorded} ${fingerprint?.scope ?? t.notRecorded} ` +
    `${fingerprint?.value ?? t.notRecorded}; files: ${fingerprint?.files ?? t.notRecorded}`;
}

/** Start and end code records; one line when they are identical. */
function provenanceLines(summary, t, { merge = false } = {}) {
  const { start, end } = summary.provenance ?? {};
  if (merge && start && end && JSON.stringify(start) === JSON.stringify(end)) {
    return [`${t.codeBoth}: ${codeState(start, t)}`];
  }
  return [["start", start], ["end", end]].map(([phase, state]) => `${t.codeAt[phase]}: ${codeState(state, t)}`);
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
    ["PENDING_TOOL_WAIT_MS", milliseconds(execution.pendingToolWaitMs, t), t.pendingScope(DEFAULT_PENDING_TOOL_WAIT_MS)],
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

/** Recorded checks across every slot, and how many of them failed. */
function checkTally(slots) {
  let total = 0;
  let failed = 0;
  for (const slot of slots) {
    for (const check of Array.isArray(slot?.checks) ? slot.checks : []) {
      total += 1;
      if (!check?.ok) failed += 1;
    }
  }
  return { total, failed };
}

/** Slots whose modelUsage named more than one model; the model check accepts any match. */
function multiModelSlots(slots) {
  return slots.filter((slot) => Array.isArray(slot?.evidence?.servedModels) && slot.evidence.servedModels.length > 1);
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
    if (c.missed?.length) console.log(`not declared: ${c.missed.join(", ")}`);
    if (c.unavailable?.length) {
      console.log(
        `not counted: ${c.unavailable.map((u) => `${u.id} (needs ${u.requiresTool})`).join(", ")}`,
      );
    }
  }
  console.log("");

  for (const line of assessmentLines(run, t)) console.log(line);
  for (const line of provenanceLines(summary, t)) console.log(line);
  console.log(t.coverageNote);
  console.log("");

  if (summary.execution) {
    console.log(`${t.settingsHeading}:`);
    for (const [key, value, scope] of executionRows(summary, t)) {
      console.log(`  ${key}: ${value} — ${scope}`);
    }
    console.log(t.settingsNote);
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

const count = (n) => Number(n).toLocaleString("en-US");

/**
 * Wording for the two documents that ship in docs/, and the labels the
 * terminal output shares with them.
 *
 * Both are rendered from the same run, so the English and the Korean file can
 * differ in phrasing but never in what they report. Every key in `en` has a
 * counterpart in `ko`.
 */
const COPY = {
  en: {
    title: (pass, total, models) =>
      `Verification: ${pass} of ${total} passed on ${models} Copilot model${models === 1 ? "" : "s"}`,
    languageLine: "> **Language / 언어:** English | [한국어](VERIFICATION_KO.md)",
    generatedComment: "<!-- Generated by scripts/verify/report.mjs. Do not edit by hand: regenerating overwrites this file. -->",
    passSentence: (pass, total) =>
      pass === total && total > 0
        ? (total === 1 ? "The one slot passed." : `All ${total} slots passed.`)
        : `${pass} of ${total} slot${total === 1 ? "" : "s"} passed.`,
    checkSentence: (checks) =>
      checks.failed
        ? `The run recorded ${count(checks.total)} checks, and ${count(checks.failed)} failed.`
        : `The run recorded ${count(checks.total)} checks, and none failed.`,
    notGreenPointer: "The reasons are listed under [Run record](#run-record).",
    legacyPointer: "This run was recorded before the strict pass policy, so it is not judged. See [Run record](#run-record).",
    slotDefinition: (models, scenarios) =>
      `A slot is one Copilot model running one scenario: here ${models} model${models === 1 ? "" : "s"} × ${scenarios} scenario${scenarios === 1 ? "" : "s"}.`,
    codeLead: (state, unchanged) => {
      if (!state?.git?.commit) return "Code: not recorded.";
      const parts = [`commit \`${state.git.commit.slice(0, 7)}\``];
      if (state.git.dirty === false) parts.push("clean working tree");
      if (state.git.dirty === true) parts.push("with uncommitted changes");
      if (unchanged === true) parts.push("unchanged during the run");
      if (unchanged === false) parts.push("changed during the run");
      return `Code: ${parts.join(", ")}.`;
    },
    claudeLead: (version) => `Claude Code: ${version ?? "not recorded"}.`,
    pendingLead: (value, defaultMs) =>
      value === defaultMs
        ? `Bridge setting: \`PENDING_TOOL_WAIT_MS=${value}\` on every bridge (the default).`
        : `Bridge setting: \`PENDING_TOOL_WAIT_MS=${value}\` on every bridge (default ${defaultMs}).`,
    harnessLead: (scale, models, scenarios) => {
      const parts = [];
      if (scale != null) parts.push(`\`--timeout-scale ${scale}\``);
      if (models != null) parts.push(`${models} model${models === 1 ? "" : "s"} in parallel`);
      if (scenarios != null) parts.push(`${scenarios} scenario${scenarios === 1 ? "" : "s"} in parallel per model`);
      return (parts.length ? `Harness: ${parts.join(", ")}. ` : "") +
        "All recorded settings: [Settings this run used](#settings-this-run-used).";
    },
    ranLead: (start, end, seconds, host) => `Ran: ${start} to ${end} (${seconds} s) on ${host}.`,
    hostText: (platform, arch, node) => `${platform} ${arch}, Node ${node}`,

    howHeading: "How each slot runs",
    howBody: [
      "- **v01–v10.** The harness starts a bridge for the slot's model (`node src/server.mjs` on a free local port) and writes a Claude Code settings file with `src/write-launch-settings.mjs`, the writer the launcher uses. " +
        "It then runs the installed `claude` binary in print mode (`-p`, stream-json output) with `--settings` pointing at that file. " +
        "Each slot has its own bridge, workspace and Claude Code config directory.",
      "- **v11.** The harness runs `bin/claude-ghcp` the way a user would: a `--background` launch that starts the persistent bridge daemon, " +
        "a `-p` launch that uses its own bridge, and an `agents` launch that goes through the daemon.",
      "",
      "No slot goes through LiteLLM, and nothing is mocked: every model turn goes to GitHub Copilot.",
      "",
      "Checks read files on disk, git history, hook logs and Claude Code's stream-json output (the init event, tool calls, tool results and the final result event). " +
        "v11 checks also read the output of the launcher, `claude-ghcp-status`, `claude-ghcp-stop` and `claude agents`, and the daemon's directory. " +
        "Checks that read the model's answer look for a value the harness planted, with two exceptions: " +
        "v05 compares a claim that every step is done with the files, and v08 requires the answer to say the command was blocked.",
      "",
      "Every Claude Code invocation in v01–v10 also gets the checks below. A slot runs one to three invocations.",
      "",
      "1. The invocation finished with a result event before its time limit.",
      "2. Every tool_use has a tool_result, and every tool_result has a tool_use.",
      "3. `modelUsage` names the slot's model or the alias Claude Code was launched with.",
      "4. The result event carries a `stop_reason` or a `subtype`.",
      "5. Usage reports more than zero input tokens.",
      "6. The result is not an error.",
      "",
      "If check 1, 2 or 3 fails, the slot is BLOCK: it could not be judged, and it counts as not passed. " +
        "A harness failure, such as a bridge that never reports healthy, also makes a slot BLOCK. " +
        "If check 4, 5 or 6 fails, the slot is FAIL. " +
        "v09 stops when its first invocation does not pass, and the two invocations it skips make the slot BLOCK. " +
        "v11 does not read Claude Code's stream-json output, so it has none of these checks. " +
        "Its own checks cover the launcher's exit codes and output, the daemon's status and the file the background agent wrote.",
    ],

    notVerifiedHeading: "Not verified by this run",
    notVerifiedIntro: "A passing run does not show the following.",
    pendingNotVerified: (value, defaultMs) =>
      `**The default \`PENDING_TOOL_WAIT_MS\`.** Every bridge in this run waited up to ${value} ms for Copilot to register a tool call. The default is ${defaultMs} ms.`,

    matrixHeading: "Results",
    scenarioColumn: "Scenario",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}** of ${total} slot${total === 1 ? "" : "s"}` +
      (gate === undefined ? "." : `, gate ${gate} (the passes a green run needs).`),
    blockedNote:
      "BLOCK means the slot could not be judged: the harness failed, a Claude Code invocation did not finish or did not run, " +
      "a tool_use or tool_result was left without its pair, or `modelUsage` did not name the slot's model. " +
      "It counts as not passed. DUP marks a slot recorded twice. UNKNOWN marks an outcome the report does not recognise. – marks a slot with no record.",
    multiModelNote:
      "In these slots `modelUsage` named more than one model. The model check passes when any entry names the slot's model or its launch alias.",
    settingsTouched: (settingsPath) =>
      `🚨 **This run is not green regardless of the tally above**: \`${settingsPath}\` changed while it ran. ` +
      "Every slot is handed its own `--settings` file and its own `CLAUDE_CONFIG_DIR`, so nothing here may touch the real one.",

    failuresHeading: "Slots that did not pass",
    noFailures: "None.",
    unrecordedOnly: "No recorded slot failed. Missing and duplicate slots are listed under [Run record](#run-record).",

    scenariosHeading: "Scenarios",
    bridgeRiskLabel: "Bridge defect it would catch:",
    passLabel: "Checks:",

    coverageHeading: "Feature coverage",
    coverageBody: (c, scenarios, listed) =>
      `The ${scenarios} scenario${scenarios === 1 ? "" : "s"} in this run declare ${c.covered?.length ?? 0} of the ${c.byFeature?.length ?? 0} features counted in \`scripts/verify/features.mjs\`: ` +
      `**${c.percent}%** by weight (${c.coveredWeight} of ${c.totalWeight}). ` +
      "The percentage counts features that scenarios list in `covers`, not checks, and it is not a pass rate. " +
      "Weights are 3 for features used in almost every session, 2 for common ones and 1 for niche ones." +
      (c.unavailable?.length
        ? ` The file lists ${listed} features. The ${c.unavailable.length} that need a tool Claude Code does not offer are not counted.`
        : ""),
    declaredHeading: "Declared without a check",
    declaredBody: "These features count toward the percentage, but no check in the named scenario tests them.",
    missedHeading: "Features no scenario declares",
    missedBody: "Whether each of these works over the bridge is in [COMPATIBILITY.md](COMPATIBILITY.md#feature-lookup).",
    absentHeading: "Tools Claude Code does not offer",
    absentBody: (measured, version, tools) =>
      `\`scripts/verify/probe.mjs\` found that Claude Code ${measured} does not offer ${tools}. ` +
      "Asked to call each one by name, the session produced no tool_use for it, while a Read call in the same turn did. " +
      (version && version !== measured ? `The probe has not been re-run on Claude Code ${version}, the version this run used. ` : "") +
      "The features that need these tools count neither as declared nor as missing:",
    needs: (tool) => `needs \`${tool}\``,

    reproduceHeading: "Reproducing",
    reproduceIntro: (commit) =>
      "`npm run verify` calls real Copilot models for every slot. It runs the checkout you have" +
      (commit ? `, so check out commit \`${commit.slice(0, 7)}\` first to re-run the code this run verified.` : "."),
    reproduceRecorded: (names) =>
      `The first command repeats this run's recorded ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}. ` +
      "Everything else, including other bridge settings and the installed Claude Code, comes from your machine.",
    reproduceMissing:
      "This run did not record its settings. The first command selects the same models and scenarios, but its waits and concurrency use today's defaults.",
    reproduce: (command, plan, models, scenarios) => [
      `${command} # ${models} models × ${scenarios} scenarios`,
      `${plan} # plan only, no model calls`,
      "npm run verify:probe        # re-measures which tools this Claude Code build lacks (makes model calls)",
      "npm run verify:report       # summarises the most recent run",
    ],
    settingsHeading: "Settings this run used",
    executionMissing: "Not recorded. The report does not guess the waits, the tool-call wait or the concurrency.",
    settingColumn: "Setting",
    recordedColumn: "Value",
    scopeColumn: "What it limits",
    scaleScope: "Multiplier for the harness waits below",
    pendingScope: (defaultMs) =>
      `Bridge setting: how long each bridge waits for Copilot to register a tool call. Default ${defaultMs} ms. Not scaled.`,
    modelScope: "Models run at the same time",
    scenarioScope: "Scenarios run at the same time for each model",
    stepScopes: {
      bridgeHealthMs: "Wait for a slot's bridge to report healthy",
      planTurnMs: "v02's plan-mode Claude Code invocation",
      backgroundLaunchMs: "v11 `--background` launch",
      foregroundLaunchMs: "v11 `-p` launch",
      persistentLaunchMs: "v11 `agents` launch through the daemon",
      detachedOutputMs: "v11 wait for the background agent's output file",
    },
    turnScope: "Each Claude Code invocation in the scenario",
    planningScope: "Not used: v11 is limited by the v11 waits above",
    settingsNote:
      "`--timeout-scale` multiplies only the harness waits in this table. " +
      "It does not scale `PENDING_TOOL_WAIT_MS`, the harness's fixed waits (such as the status, stop, `claude agents` and cleanup commands, polling, v03's test re-run and the 5 s grace before SIGKILL), " +
      "or the launcher's and daemon's own startup limits.",

    recordHeading: "Run record",
    recordSource: (runId) =>
      `This page is generated by \`scripts/verify/report.mjs\` from run \`${runId}\`: its \`summary.json\` and \`slots.jsonl\`, which stay on the machine that ran it and are not committed. ` +
      "The results, settings and code record come from that run. Scenario text and the feature list come from `scripts/verify/` when the page is generated. " +
      "Earlier runs and one-off live checks are in [VERIFICATION_HISTORY.md](VERIFICATION_HISTORY.md).",
    fingerprintNote:
      "The fingerprint is a SHA-256 hash of the code files in `src/`, `bin/`, `scripts/verify/` and the package manifests.",
    userSettingsLabel: "user settings file",
    userSettingsState: (intact) => intact === true ? "unchanged" : intact === false ? "changed" : "not recorded",

    policyLabel: "policy",
    legacyPolicy: "legacy stored policy",
    scopeLabel: "scope",
    fullMatrixSlots: (n) => n == null ? "full matrix size not recorded" : `${n} slots in the full matrix`,
    expectedLabel: "expected",
    actualLabel: "actual",
    resultLabel: "result",
    storedGreenLabel: "stored green",
    legacyNote: "An older run's stored gate and green flag are not a strict all-pass verdict. The report does not fill in a missing policy or code record.",
    strictNote:
      "PASS needs all of these: the recorded matrix is complete with no duplicate or unexpected slot, every slot passed, " +
      "the user's Claude Code settings file did not change, and the code at the end of the run matched the code at the start.",
    focusedNote: "This run selected part of the matrix. Its PASS covers only the selected slots and is not a full-matrix pass.",
    unknownLabel: "unknown outcomes",
    problemLabel: "problem",
    missingLabel: "missing slot",
    duplicateLabel: "duplicate slot",
    unexpectedLabel: "unexpected slot",
    codeAt: { start: "code at start", end: "code at end" },
    codeBoth: "code at start and end",
    coverageNote: "Feature coverage counts features the scenarios declare, not checks. It is not a pass rate.",
    notRecorded: "not recorded",
  },
  ko: {
    title: (pass, total, models) => `검증 결과: Copilot 모델 ${models}개, ${total}개 슬롯 중 ${pass}개 통과`,
    languageLine: "> **언어 / Language:** [English](VERIFICATION.md) | 한국어",
    generatedComment: "<!-- scripts/verify/report.mjs가 생성하는 파일입니다. 다시 생성하면 덮어쓰므로 직접 고치지 마세요. -->",
    passSentence: (pass, total) =>
      pass === total && total > 0 ? `${total}개 슬롯이 모두 통과했습니다.` : `${total}개 슬롯 중 ${pass}개가 통과했습니다.`,
    checkSentence: (checks) =>
      checks.failed
        ? `기록된 검사 ${count(checks.total)}개 중 ${count(checks.failed)}개가 실패했습니다.`
        : `기록된 검사 ${count(checks.total)}개 중 실패한 검사는 없습니다.`,
    notGreenPointer: "이유는 [실행 기록](#실행-기록)에 있습니다.",
    legacyPointer: "엄격한 통과 정책이 생기기 전에 기록한 실행이라 판정하지 않습니다. [실행 기록](#실행-기록)을 보세요.",
    slotDefinition: (models, scenarios) =>
      `슬롯은 Copilot 모델 하나가 시나리오 하나를 실행하는 단위이며, 이 실행은 모델 ${models}개 × 시나리오 ${scenarios}개입니다.`,
    codeLead: (state, unchanged) => {
      if (!state?.git?.commit) return "코드: 기록 없음.";
      const parts = [`코드: 커밋 \`${state.git.commit.slice(0, 7)}\`.`];
      if (state.git.dirty === false) parts.push("커밋하지 않은 변경이 없었습니다.");
      if (state.git.dirty === true) parts.push("커밋하지 않은 변경이 있었습니다.");
      if (unchanged === true) parts.push("실행하는 동안 코드가 바뀌지 않았습니다.");
      if (unchanged === false) parts.push("실행하는 동안 코드가 바뀌었습니다.");
      return parts.join(" ");
    },
    claudeLead: (version) => `Claude Code: ${version ?? "기록 없음"}.`,
    pendingLead: (value, defaultMs) =>
      value === defaultMs
        ? `브리지 설정(모든 브리지 공통): \`PENDING_TOOL_WAIT_MS=${value}\`, 기본값과 같습니다.`
        : `브리지 설정(모든 브리지 공통): \`PENDING_TOOL_WAIT_MS=${value}\`, 기본값은 ${defaultMs}입니다.`,
    harnessLead: (scale, models, scenarios) => {
      const parts = [];
      if (scale != null) parts.push(`\`--timeout-scale ${scale}\``);
      if (models != null) parts.push(`모델 ${models}개 병렬`);
      if (scenarios != null) parts.push(`모델마다 시나리오 ${scenarios}개 병렬`);
      return (parts.length ? `검증 하네스: ${parts.join(", ")}. ` : "") +
        "기록된 설정 전체는 [이 실행의 설정](#이-실행의-설정)에 있습니다.";
    },
    ranLead: (start, end, seconds, host) => `실행: ${start}부터 ${end}까지 ${seconds}초. 호스트: ${host}.`,
    hostText: (platform, arch, node) => `${platform} ${arch}, Node ${node}`,

    howHeading: "슬롯 실행 방식",
    howBody: [
      "- **v01–v10.** 검증 하네스가 슬롯의 모델에 맞춘 브리지(`node src/server.mjs`, 비어 있는 로컬 포트)를 띄우고, 런처가 쓰는 것과 같은 `src/write-launch-settings.mjs`로 Claude Code 설정 파일을 만듭니다. " +
        "그다음 설치된 `claude` 바이너리를 print 모드(`-p`, stream-json 출력)로 실행하면서 `--settings`로 그 파일을 넘깁니다. " +
        "슬롯마다 브리지, 작업 폴더, Claude Code 설정 폴더가 따로 있습니다.",
      "- **v11.** 하네스가 사용자처럼 `bin/claude-ghcp`를 실행합니다. 상주 브리지 데몬을 띄우는 `--background` 실행, " +
        "자체 브리지를 쓰는 `-p` 실행, 데몬을 거치는 `agents` 실행입니다.",
      "",
      "LiteLLM을 거치는 슬롯은 없고, 모의 응답이나 대체 구현도 쓰지 않습니다. 모든 모델 턴은 GitHub Copilot으로 갑니다.",
      "",
      "검사는 디스크의 파일, git 이력, 훅 로그, Claude Code의 stream-json 출력(init 이벤트, 도구 호출, 도구 결과, 마지막 result 이벤트)을 읽습니다. " +
        "v11 검사는 런처, `claude-ghcp-status`, `claude-ghcp-stop`, `claude agents`의 출력과 데몬 폴더도 읽습니다. " +
        "모델의 답을 읽는 검사는 하네스가 심어 둔 값을 찾습니다. 예외는 두 가지입니다. " +
        "v05는 모든 단계를 마쳤다는 주장을 파일과 대조하고, v08은 명령이 차단되었다는 말이 답에 있어야 합니다.",
      "",
      "v01–v10의 Claude Code 실행에는 모두 아래 검사가 더 붙습니다. 한 슬롯은 Claude Code를 1–3회 실행합니다.",
      "",
      "1. 제한 시간 안에 result 이벤트로 끝났습니다.",
      "2. 모든 tool_use에 tool_result가 있고, 모든 tool_result에 tool_use가 있습니다.",
      "3. `modelUsage`에 슬롯의 모델이나 Claude Code를 실행할 때 쓴 별칭이 있습니다.",
      "4. result 이벤트에 `stop_reason`이나 `subtype`이 있습니다.",
      "5. usage의 입력 토큰이 0보다 큽니다.",
      "6. result가 오류가 아닙니다.",
      "",
      "1–3번 중 하나라도 실패하면 슬롯은 BLOCK입니다. 판정할 수 없다는 뜻이며 미통과로 셉니다. " +
        "브리지가 끝내 정상 응답을 하지 않는 것처럼 검증 하네스 자체가 실패해도 BLOCK입니다. " +
        "4–6번 중 하나라도 실패하면 FAIL입니다. " +
        "v09는 첫 번째 실행이 통과하지 못하면 멈추고, 건너뛴 두 실행 때문에 슬롯은 BLOCK이 됩니다. " +
        "v11은 Claude Code의 stream-json 출력을 읽지 않으므로 이 검사가 없습니다. " +
        "대신 런처의 종료 코드와 출력, 데몬 상태, 백그라운드 에이전트가 쓴 파일을 검사합니다.",
    ],

    notVerifiedHeading: "이 실행으로 검증하지 않은 것",
    notVerifiedIntro: "통과한 실행이라도 아래 내용은 보여 주지 않습니다.",
    pendingNotVerified: (value, defaultMs) =>
      `**기본 \`PENDING_TOOL_WAIT_MS\` 값.** 이 실행의 모든 브리지는 Copilot이 도구 호출을 등록하기를 최대 ${value} ms 기다렸습니다. 기본값은 ${defaultMs} ms입니다.`,

    matrixHeading: "결과 매트릭스",
    scenarioColumn: "시나리오",
    tally: (c, total, gate) =>
      `**pass ${c.pass} / fail ${c.fail} / blocked ${c.blocked}**, 전체 ${total}개 슬롯` +
      (gate === undefined ? "." : `, 통과 기준 ${gate}(통과해야 하는 슬롯 수).`),
    blockedNote:
      "BLOCK은 슬롯을 판정할 수 없었다는 뜻입니다. 하네스가 실패했거나, Claude Code 실행이 끝나지 않았거나 실행되지 않았거나, " +
      "tool_use나 tool_result가 짝 없이 남았거나, `modelUsage`에 슬롯의 모델이 없었던 경우입니다. " +
      "미통과로 셉니다. DUP는 두 번 기록된 슬롯, UNKNOWN은 이 보고서가 모르는 결과, –는 기록이 없는 슬롯입니다.",
    multiModelNote:
      "아래 슬롯에서는 `modelUsage`에 모델이 둘 이상 있었습니다. 모델 검사는 그중 하나라도 슬롯의 모델이나 실행할 때 쓴 별칭이면 통과합니다.",
    settingsTouched: (settingsPath) =>
      `🚨 **위 집계와 무관하게 이 실행은 통과가 아닙니다.** 실행 도중 \`${settingsPath}\` 파일이 바뀌었습니다. ` +
      "모든 슬롯은 전용 `--settings` 파일과 전용 `CLAUDE_CONFIG_DIR`를 받으므로, 실제 사용자 설정을 건드려서는 안 됩니다.",

    failuresHeading: "통과하지 못한 슬롯",
    noFailures: "없습니다.",
    unrecordedOnly: "기록된 슬롯 중 실패한 것은 없습니다. 누락되거나 중복된 슬롯은 [실행 기록](#실행-기록)에 있습니다.",

    scenariosHeading: "시나리오",
    bridgeRiskLabel: "잡아내려는 브리지 결함:",
    passLabel: "검사:",

    coverageHeading: "기능 커버리지",
    coverageBody: (c, scenarios, listed) =>
      `이 실행의 시나리오 ${scenarios}개는 \`scripts/verify/features.mjs\`에서 세는 기능 ${c.byFeature?.length ?? 0}개 중 ${c.covered?.length ?? 0}개를 선언합니다. ` +
      `가중치로는 **${c.percent}%**(${c.totalWeight} 중 ${c.coveredWeight})입니다. ` +
      "이 비율은 검사가 아니라 시나리오가 `covers`에 적은 기능을 센 값이고, 통과율이 아닙니다. " +
      "가중치는 거의 모든 세션에서 쓰는 기능이 3, 자주 쓰는 기능이 2, 드물게 쓰는 기능이 1입니다." +
      (c.unavailable?.length
        ? ` 파일에는 기능이 ${listed}개 있고, 그중 Claude Code에 없는 도구가 필요한 ${c.unavailable.length}개는 세지 않습니다.`
        : ""),
    declaredHeading: "선언했지만 검사하지 않는 기능",
    declaredBody: "아래 기능은 비율에 들어가지만, 적힌 시나리오의 검사 중 이 기능을 확인하는 것은 없습니다.",
    missedHeading: "어느 시나리오도 선언하지 않은 기능",
    missedBody: "각 기능이 브리지에서 동작하는지는 [COMPATIBILITY_KO.md](COMPATIBILITY_KO.md#기능별-확인)에서 확인하세요.",
    absentHeading: "Claude Code에 없는 도구",
    absentBody: (measured, version, tools) =>
      `\`scripts/verify/probe.mjs\`로 확인한 결과 Claude Code ${measured}에는 다음 도구가 없습니다: ${tools}. ` +
      "각 도구를 이름으로 지정해 호출하게 했을 때, 같은 턴의 Read 호출은 tool_use를 만들었지만 이 도구들은 만들지 않았습니다. " +
      (version && version !== measured ? `이 실행이 쓴 Claude Code ${version}에서는 프로브를 다시 돌리지 않았습니다. ` : "") +
      "이 도구가 있어야 하는 기능은 선언한 것으로도, 빠진 것으로도 세지 않습니다.",
    needs: (tool) => `\`${tool}\` 필요`,

    reproduceHeading: "재현",
    reproduceIntro: (commit) =>
      "`npm run verify`는 모든 슬롯에서 실제 Copilot 모델을 호출하며, 지금 체크아웃된 코드를 실행합니다." +
      (commit ? ` 이 실행이 검증한 코드를 다시 돌리려면 먼저 다음 커밋을 체크아웃하세요: \`${commit.slice(0, 7)}\`.` : ""),
    reproduceRecorded: (names) =>
      `첫 번째 명령은 이 실행에 기록된 ${names.join(", ")} 값을 그대로 씁니다. ` +
      "다른 브리지 설정과 설치된 Claude Code를 포함한 나머지는 실행하는 컴퓨터의 것을 씁니다.",
    reproduceMissing:
      "이 실행은 설정을 기록하지 않았습니다. 첫 번째 명령은 같은 모델과 시나리오를 고르지만, 대기 시간과 동시성에는 현재 기본값을 씁니다.",
    reproduce: (command, plan, models, scenarios) => [
      `${command} # 모델 ${models}개 × 시나리오 ${scenarios}개`,
      `${plan} # 모델 호출 없이 계획만 출력`,
      "npm run verify:probe        # 이 Claude Code 빌드에 없는 도구를 다시 확인 (모델 호출)",
      "npm run verify:report       # 가장 최근 실행 요약",
    ],
    settingsHeading: "이 실행의 설정",
    executionMissing: "기록 없음. 대기 시간, 도구 호출 대기, 동시성을 추정하지 않습니다.",
    settingColumn: "설정",
    recordedColumn: "값",
    scopeColumn: "적용 대상",
    scaleScope: "아래 하네스 대기 시간에 곱하는 배율",
    pendingScope: (defaultMs) =>
      `브리지 설정. 각 브리지가 Copilot이 도구 호출을 등록하기를 기다리는 시간. 기본값 ${defaultMs} ms. 배율 적용 안 함.`,
    modelScope: "동시에 실행하는 모델 수",
    scenarioScope: "모델마다 동시에 실행하는 시나리오 수",
    stepScopes: {
      bridgeHealthMs: "슬롯 브리지가 정상 응답할 때까지 대기",
      planTurnMs: "v02의 plan 모드 Claude Code 실행",
      backgroundLaunchMs: "v11의 `--background` 실행",
      foregroundLaunchMs: "v11의 `-p` 실행",
      persistentLaunchMs: "v11에서 데몬을 거치는 `agents` 실행",
      detachedOutputMs: "v11에서 백그라운드 에이전트의 출력 파일 대기",
    },
    turnScope: "이 시나리오의 Claude Code 실행 1회마다",
    planningScope: "쓰지 않음. v11은 위의 v11 대기 시간을 따름",
    settingsNote:
      "`--timeout-scale`은 이 표의 하네스 대기 시간에만 곱합니다. " +
      "`PENDING_TOOL_WAIT_MS`, 하네스의 고정 대기(status·stop·`claude agents`·정리 명령, 폴링, v03의 테스트 재실행, SIGKILL 전 5초 유예 등), " +
      "런처와 데몬 자체의 시작 제한에는 배율을 적용하지 않습니다.",

    recordHeading: "실행 기록",
    recordSource: (runId) =>
      `이 문서는 \`scripts/verify/report.mjs\`가 실행 \`${runId}\`의 \`summary.json\`과 \`slots.jsonl\`로 만듭니다. 이 두 파일은 실행한 컴퓨터에만 있고 커밋하지 않습니다. ` +
      "결과, 설정, 코드 기록은 그 실행에서 가져옵니다. 시나리오 설명과 기능 목록은 문서를 생성할 때의 `scripts/verify/`에서 가져옵니다. " +
      "이전 실행과 일회성 실측은 [VERIFICATION_HISTORY_KO.md](VERIFICATION_HISTORY_KO.md)에 있습니다.",
    fingerprintNote:
      "코드 지문(fingerprint)은 `src/`, `bin/`, `scripts/verify/`의 코드 파일과 패키지 매니페스트로 계산한 SHA-256 해시입니다.",
    userSettingsLabel: "사용자 설정 파일",
    userSettingsState: (intact) => intact === true ? "바뀌지 않음" : intact === false ? "바뀜" : "기록 없음",

    policyLabel: "정책",
    legacyPolicy: "legacy 저장 정책",
    scopeLabel: "범위",
    fullMatrixSlots: (n) => n == null ? "전체 매트릭스 크기 기록 없음" : `전체 매트릭스 ${n}개 슬롯`,
    expectedLabel: "예상",
    actualLabel: "실제",
    resultLabel: "결과",
    storedGreenLabel: "저장된 green",
    legacyNote: "예전 실행이 저장한 gate와 green 값은 엄격한 전체 통과 판정이 아닙니다. 없는 정책이나 코드 기록을 추정하지 않습니다.",
    strictNote:
      "PASS가 되려면 다음을 모두 만족해야 합니다. 기록한 매트릭스에 빠지거나 중복되거나 예상 밖인 슬롯이 없고, 모든 슬롯이 통과하고, " +
      "사용자의 Claude Code 설정 파일이 바뀌지 않고, 실행이 끝날 때의 코드가 시작할 때와 같아야 합니다.",
    focusedNote: "이 실행은 매트릭스의 일부만 골랐습니다. PASS는 고른 슬롯에만 해당하며 전체 매트릭스 통과가 아닙니다.",
    unknownLabel: "알 수 없는 결과",
    problemLabel: "문제",
    missingLabel: "누락 슬롯",
    duplicateLabel: "중복 슬롯",
    unexpectedLabel: "예상 밖 슬롯",
    codeAt: { start: "시작 시 코드", end: "종료 시 코드" },
    codeBoth: "시작과 종료 시 코드",
    coverageNote: "기능 커버리지는 검사가 아니라 시나리오가 선언한 기능을 센 값이며, 통과율이 아닙니다.",
    notRecorded: "기록 없음",
  },
};

function printMarkdown(run, lang = "en") {
  const t = COPY[lang] ?? COPY.en;
  const ko = lang === "ko";
  const { slots, summary } = run;
  const a = run.assessment;
  const { models, scenarioIds } = axes(run);
  const { byKey } = matrix(slots, models, scenarioIds);
  const { counts, gate } = a;
  const total = a.policyKind === "strict" ? a.expectedTotal ?? slots.length : slots.length;
  const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
  const c = coverageFor(run) ?? {};
  const execution = summary.execution;
  const { start, end } = summary.provenance ?? {};
  const sameCode = start && end
    ? start.git?.commit === end.git?.commit && start.fingerprint?.value === end.fingerprint?.value
    : null;

  const out = [];
  out.push(`# ${t.title(counts.pass, total, models.length)}`);
  out.push("");
  out.push(t.generatedComment);
  out.push("");
  out.push(t.languageLine);
  out.push("");

  // The lead: the verdict first, then what it was measured on.
  const lead = [`**${resultWord(a)}.**`, t.passSentence(counts.pass, total), t.checkSentence(checkTally(slots))];
  if (a.policyKind === "legacy") lead.push(t.legacyPointer);
  else if (!a.green) lead.push(t.notGreenPointer);
  out.push(lead.join(" "));
  out.push("");
  out.push(t.slotDefinition(models.length, scenarioIds.length));
  out.push("");
  out.push(`- ${t.codeLead(start, sameCode)}`);
  out.push(`- ${t.claudeLead(summary.claude?.version)}`);
  if (execution?.pendingToolWaitMs != null) {
    out.push(`- ${t.pendingLead(execution.pendingToolWaitMs, DEFAULT_PENDING_TOOL_WAIT_MS)}`);
  }
  if (execution) {
    out.push(`- ${t.harnessLead(
      execution.timeouts?.scale ?? null,
      execution.modelConcurrency ?? null,
      execution.scenarioConcurrency ?? null,
    )}`);
  }
  out.push(`- ${t.ranLead(
    summary.startedAt ?? t.notRecorded,
    summary.finishedAt ?? t.notRecorded,
    summary.durationSeconds ?? "?",
    summary.host ? t.hostText(summary.host.platform ?? "?", summary.host.arch ?? "?", summary.node ?? "?") : t.notRecorded,
  )}`);
  out.push("");

  out.push(`## ${t.howHeading}`);
  out.push("");
  out.push(...t.howBody);
  out.push("");

  out.push(`## ${t.notVerifiedHeading}`);
  out.push("");
  out.push(t.notVerifiedIntro);
  out.push("");
  for (const item of ko ? NOT_VERIFIED.ko : NOT_VERIFIED.en) out.push(`- ${item}`);
  if (execution?.pendingToolWaitMs != null && execution.pendingToolWaitMs !== DEFAULT_PENDING_TOOL_WAIT_MS) {
    out.push(`- ${t.pendingNotVerified(execution.pendingToolWaitMs, DEFAULT_PENDING_TOOL_WAIT_MS)}`);
  }
  out.push("");

  out.push(`## ${t.matrixHeading}`);
  out.push("");
  out.push(`| ${t.scenarioColumn} | ${models.join(" | ")} |`);
  out.push(`| --- | ${models.map(() => "---").join(" | ")} |`);
  let allPassCells = true;
  for (const id of scenarioIds) {
    const cells = models.map((model) => {
      const slot = byKey.get(slotKey({ model, scenario: id }));
      if (!slot) return "–";
      return Object.hasOwn(MARK, slot.outcome) ? MARK[slot.outcome] : "UNKNOWN";
    });
    if (cells.some((mark) => mark !== MARK.pass)) allPassCells = false;
    out.push(`| \`${id}\` | ${cells.join(" | ")} |`);
  }
  out.push("");
  // The gate only adds information when the run is not a clean strict pass.
  const showGate = a.policyKind !== "strict" || !a.green;
  out.push(t.tally(counts, total, showGate ? gate ?? t.notRecorded : undefined));
  out.push("");
  if (!allPassCells) {
    out.push(t.blockedNote);
    out.push("");
  }
  // A run that rewrote the machine it ran on is not green however the slots
  // landed, so the tally above must not be the last word on it.
  if (summary.userSettings && summary.userSettings.intact === false) {
    out.push(t.settingsTouched(summary.userSettings.path));
    out.push("");
  }
  const multi = multiModelSlots(slots);
  if (multi.length) {
    out.push(t.multiModelNote);
    out.push("");
    for (const slot of multi) {
      out.push(`- ${slot.model} × \`${slot.scenario}\`: ${slot.evidence.servedModels.map((m) => `\`${m}\``).join(", ")}`);
    }
    out.push("");
  }

  const bad = slots.filter((s) => s?.outcome !== "pass");
  out.push(`## ${t.failuresHeading}`);
  out.push("");
  if (!bad.length) {
    out.push(allPassCells ? t.noFailures : t.unrecordedOnly);
    out.push("");
  } else {
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

  out.push(`## ${t.scenariosHeading}`);
  out.push("");
  for (const id of scenarioIds) {
    const scenario = byId.get(id);
    if (!scenario) continue;
    out.push(`### \`${id}\` — ${ko ? scenario.nameKo : scenario.name}`);
    out.push("");
    out.push(ko ? scenario.intentKo : scenario.intent);
    out.push("");
    out.push(`**${t.bridgeRiskLabel}** ${ko ? scenario.bridgeRiskKo : scenario.bridgeRisk}`);
    out.push("");
    out.push(t.passLabel);
    out.push("");
    const pass = ko && scenario.passKo?.length ? scenario.passKo : scenario.pass;
    for (const line of pass) out.push(`- ${line}`);
    out.push("");
  }

  out.push(`## ${t.coverageHeading}`);
  out.push("");
  out.push(t.coverageBody(c, scenarioIds.length, FEATURES.length));
  out.push("");
  const declared = DECLARED_WITHOUT_CHECK.filter((entry) => scenarioIds.includes(entry.scenario));
  if (declared.length) {
    out.push(`### ${t.declaredHeading}`);
    out.push("");
    out.push(t.declaredBody);
    out.push("");
    for (const entry of declared) {
      out.push(`- \`${entry.feature}\` (\`${entry.scenario}\`): ${ko ? entry.ko : entry.en}`);
    }
    out.push("");
  }
  if (c.missed?.length) {
    out.push(`### ${t.missedHeading}`);
    out.push("");
    for (const id of c.missed) {
      const f = FEATURES.find((x) => x.id === id);
      out.push(`- \`${id}\`: ${(ko ? f?.nameKo : f?.name) ?? ""}`);
    }
    out.push("");
    out.push(t.missedBody);
    out.push("");
  }
  if (c.unavailable?.length) {
    out.push(`### ${t.absentHeading}`);
    out.push("");
    out.push(t.absentBody(
      ABSENT_TOOLS_MEASURED_ON,
      summary.claude?.version ?? null,
      ABSENT_TOOLS.map((tool) => `\`${tool}\``).join(", "),
    ));
    out.push("");
    for (const u of c.unavailable) {
      const f = FEATURES.find((x) => x.id === u.id);
      out.push(`- \`${u.id}\` (${t.needs(u.requiresTool)}): ${(ko ? f?.nameKo : f?.name) ?? ""}`);
    }
    out.push("");
  }

  out.push(`## ${t.reproduceHeading}`);
  out.push("");
  const recordedFlags = [
    ["`--timeout-scale`", execution?.timeouts?.scale],
    ["`--model-concurrency`", execution?.modelConcurrency],
    ["`--scenario-concurrency`", execution?.scenarioConcurrency],
    ["`PENDING_TOOL_WAIT_MS`", execution?.pendingToolWaitMs],
  ].filter(([, value]) => value != null).map(([name]) => name);
  out.push(`${t.reproduceIntro(start?.git?.commit ?? null)} ${recordedFlags.length ? t.reproduceRecorded(recordedFlags) : t.reproduceMissing}`);
  out.push("");
  out.push("```bash");
  for (const line of t.reproduce(
    verificationCommand(run), verificationCommand(run, true), models.length, scenarioIds.length,
  )) out.push(line);
  out.push("```");
  out.push("");
  out.push(`### ${t.settingsHeading}`);
  out.push("");
  if (execution) {
    out.push(`| ${t.settingColumn} | ${t.recordedColumn} | ${t.scopeColumn} |`);
    out.push("| --- | --- | --- |");
    for (const [key, value, scope] of executionRows(summary, t)) {
      out.push(`| \`${key}\` | ${value} | ${scope} |`);
    }
    out.push("");
    out.push(t.settingsNote);
    out.push("");
  } else {
    out.push(t.executionMissing, "");
  }

  out.push(`## ${t.recordHeading}`);
  out.push("");
  out.push(t.recordSource(path.basename(path.resolve(run.dir))));
  out.push("");
  for (const line of assessmentLines(run, t)) out.push(`- ${line}`);
  for (const line of provenanceLines(summary, t, { merge: true })) out.push(`- ${line}`);
  out.push(`- ${t.userSettingsLabel}: ${t.userSettingsState(summary.userSettings?.intact)}`);
  out.push("");
  out.push(t.fingerprintNote);
  out.push("");

  console.log(out.join("\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, ""));
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

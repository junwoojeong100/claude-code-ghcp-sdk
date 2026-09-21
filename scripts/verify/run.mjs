#!/usr/bin/env node
/**
 * Verification runner: the full scenario catalog x 7 primary Copilot models.
 *
 * Contract:
 *  - Every slot runs the real path. Real Claude Code binary, real bridge, real
 *    Copilot SDK, real model. Nothing is stubbed or replayed.
 *  - Every slot gets its own bridge, port, token, config dir and workspace, so
 *    one model's stall cannot be read as another's failure.
 *  - `blocked` is never a pass. It stays in the denominator.
 *  - The serving model is read from result.modelUsage, not from the label.
 *
 * Usage:
 *   node scripts/verify/run.mjs
 *   node scripts/verify/run.mjs --models claude-opus-5 --scenarios v01-repo-recon
 *   node scripts/verify/run.mjs --dry-run
 *   PENDING_TOOL_WAIT_MS=30000 node scripts/verify/run.mjs --timeout-scale 2
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { settingsFileState } from "../../src/settings-file-state.mjs";
import { PRIMARY_MODELS, SCENARIOS, DEFAULT_PLAN, gateFor, planRun, validateCatalog } from "./scenarios.mjs";
import { DRIVERS } from "./drivers.mjs";
import { buildFixture } from "./fixtures.mjs";
import { createTimeoutPolicy, parseTimeoutScale, readPendingToolWaitMs } from "./timeouts.mjs";
import {
  ROOT_DIR,
  assertModelServed,
  claudeVersion,
  readTail,
  resolveClaudeBin,
  seedConfigDir,
  startBridge,
  writeLaunchSettings,
} from "./bridge.mjs";

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    models: [...PRIMARY_MODELS],
    scenarios: SCENARIOS.map((s) => s.id),
    modelConcurrency: DEFAULT_PLAN.modelConcurrency,
    scenarioConcurrency: DEFAULT_PLAN.scenarioConcurrency,
    timeoutScale: 1,
    outDir: path.join(ROOT_DIR, ".verify-runs"),
    dryRun: false,
    keepWorkspaces: false,
  };
  const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--models") opts.models = list(next());
    else if (arg === "--scenarios") opts.scenarios = list(next());
    else if (arg === "--model-concurrency") opts.modelConcurrency = Number(next());
    else if (arg === "--scenario-concurrency") opts.scenarioConcurrency = Number(next());
    else if (arg === "--timeout-scale") opts.timeoutScale = parseTimeoutScale(next());
    else if (arg === "--out") opts.outDir = path.resolve(next());
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--keep-workspaces") opts.keepWorkspaces = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  const unknownModel = opts.models.find((m) => !PRIMARY_MODELS.includes(m));
  if (unknownModel) throw new Error(`Unknown model: ${unknownModel}`);
  const known = new Set(SCENARIOS.map((s) => s.id));
  const unknownScenario = opts.scenarios.find((s) => !known.has(s));
  if (unknownScenario) throw new Error(`Unknown scenario: ${unknownScenario}`);
  return opts;
}

/* ------------------------------------------------------------------ *
 * Slot execution
 * ------------------------------------------------------------------ */

async function runSlot({ model, scenario, runDir, claudeBin, keepWorkspaces, timeouts }) {
  const slotId = `${model}__${scenario.id}`;
  const slotDir = path.join(runDir, "slots", slotId);
  const configDir = path.join(slotDir, "config");
  const settingsPath = path.join(slotDir, "settings.json");
  const bridgeLog = path.join(slotDir, "bridge.log");

  fs.mkdirSync(slotDir, { recursive: true });

  // The workspace lives outside this checkout; only the artifacts stay in it.
  //
  // .verify-runs/ is inside the repository, so a workspace under it is a git
  // repo nested in another one. A scenario that asks for `git worktree add
  // ../wt` then resolves to the REAL repository -- under bypassPermissions that
  // took a commit onto the working branch and left a stray branch behind. A
  // temp dir has no parent repo to escape into.
  //
  // The temp dir is the slot's and the workspace sits inside it, because a
  // scenario may legitimately create siblings of its workspace. Everything the
  // slot makes is then under one root that cleanup removes whole.
  const slotTmp = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `verify-${scenario.id}-`),
  );
  const workspace = path.join(slotTmp, "workspace");
  const startedAt = Date.now();

  const record = {
    slotId,
    model,
    scenario: scenario.id,
    scenarioName: scenario.name,
    covers: scenario.covers,
    startedAt: new Date(startedAt).toISOString(),
  };

  let bridge = null;
  try {
    bridge = await startBridge({ model, logPath: bridgeLog, healthTimeoutMs: timeouts.bridgeHealthMs });
    record.frontendModel = bridge.frontendModel;
    record.bridgePort = bridge.port;

    await assertModelServed(bridge);
    writeLaunchSettings({ bridge, settingsPath });
    seedConfigDir(configDir, { version: claudeVersion(claudeBin) });

    const fixture = buildFixture(scenario.id, workspace);
    const driver = DRIVERS[scenario.id];

    const outcome = await driver({
      scenario,
      model,
      frontendModel: bridge.frontendModel,
      bridge,
      workspace,
      fixture,
      settingsPath,
      configDir,
      claudeBin,
      slotDir,
      timeoutSeconds: timeouts.scenarioMs[scenario.id] / 1000,
      timeouts,
    });

    Object.assign(record, outcome);
  } catch (error) {
    // A harness failure is `blocked`: it says nothing about the model.
    record.outcome = "blocked";
    record.reason = `${error.name ?? "Error"}: ${error.message}`;
    record.checks = record.checks ?? [];
    record.evidence = { bridgeLog: readTail(bridgeLog, 800) };
  } finally {
    if (bridge) {
      try { await bridge.stop(); } catch {}
    }
    if (!keepWorkspaces && record.outcome === "pass") {
      try { fs.rmSync(slotTmp, { recursive: true, force: true }); } catch {}
    } else {
      // Kept for inspection, and it is no longer next to the artifacts, so the
      // record has to say where it went.
      record.workspace = workspace;
    }
  }

  record.durationMs = Date.now() - startedAt;
  record.finishedAt = new Date().toISOString();
  return record;
}

/* ------------------------------------------------------------------ *
 * Worker pools
 * ------------------------------------------------------------------ */

async function pool(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const ICON = { pass: "PASS", fail: "FAIL", blocked: "BLOCK" };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }

  const catalog = validateCatalog();
  if (!catalog.ok) {
    console.error("Scenario catalog is invalid:");
    for (const problem of catalog.problems) console.error(`  - ${problem}`);
    return 1;
  }

  const scenarios = SCENARIOS.filter((s) => opts.scenarios.includes(s.id));
  const timeouts = createTimeoutPolicy(scenarios, opts.timeoutScale);
  const execution = {
    modelConcurrency: opts.modelConcurrency,
    scenarioConcurrency: opts.scenarioConcurrency,
    pendingToolWaitMs: readPendingToolWaitMs(process.env),
    timeouts,
  };
  const plan = planRun({
    scenarios,
    models: opts.models,
    modelConcurrency: opts.modelConcurrency,
    scenarioConcurrency: opts.scenarioConcurrency,
    timeoutScale: timeouts.scale,
  });

  console.log(`models:    ${opts.models.length}  (${opts.models.join(", ")})`);
  console.log(`scenarios: ${scenarios.length}`);
  console.log(`slots:     ${plan.slots}`);
  console.log(`coverage:  ${catalog.coverage.percent}% weighted of Claude Code core features`);
  console.log(`single-turn scheduling estimate ~${Math.round(plan.wallClockSeconds / 60)} min, peak ${plan.peakClaudeProcesses} Claude processes`);
  console.log("Planning estimate only, not a deadline or worst-case bound; extra turns, startup and cleanup can take longer.");
  console.log(`execution: ${JSON.stringify(execution)}`);

  if (opts.dryRun) {
    console.log("\n--dry-run: no calls made.");
    return 0;
  }

  const claudeBin = resolveClaudeBin();
  const version = claudeVersion(claudeBin);
  console.log(`claude:    ${claudeBin} (${version})\n`);

  // Every slot is handed its own --settings file and its own CLAUDE_CONFIG_DIR,
  // so nothing here should ever touch the real one. That is a claim about the
  // launcher and the CLI, not a wish, so it is measured: hash the user's
  // settings before and after and fail the run if the two differ. A suite that
  // silently rewrote the machine it ran on would still go green otherwise.
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const userSettingsBefore = settingsFileState(userSettingsPath);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, stamp);
  fs.mkdirSync(path.join(runDir, "slots"), { recursive: true });
  const slotsPath = path.join(runDir, "slots.jsonl");
  const slotStream = fs.createWriteStream(slotsPath, { flags: "a" });

  const startedAt = Date.now();
  let done = 0;
  const total = plan.slots;

  const records = await pool(opts.models, opts.modelConcurrency, async (model) => {
    const perModel = await pool(scenarios, opts.scenarioConcurrency, async (scenario) => {
      const record = await runSlot({
        model,
        scenario,
        runDir,
        claudeBin,
        keepWorkspaces: opts.keepWorkspaces,
        timeouts,
      });
      slotStream.write(JSON.stringify(record) + "\n");
      done += 1;
      const seconds = Math.round(record.durationMs / 1000);
      console.log(
        `[${String(done).padStart(2)}/${total}] ${String(ICON[record.outcome] ?? "?").padEnd(5)} ` +
          `${model.padEnd(16)} ${record.scenario.padEnd(18)} ${String(seconds).padStart(3)}s` +
          (record.outcome === "pass" ? "" : `  ${String(record.reason ?? "").slice(0, 120)}`),
      );
      return record;
    });
    return perModel;
  });

  await new Promise((resolve) => slotStream.end(resolve));
  const flat = records.flat();

  const counts = { pass: 0, fail: 0, blocked: 0 };
  for (const record of flat) counts[record.outcome] = (counts[record.outcome] ?? 0) + 1;

  const userSettingsAfter = settingsFileState(userSettingsPath);
  const userSettingsIntact = userSettingsBefore === userSettingsAfter;

  const gate = gateFor(flat.length);
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    claude: { bin: claudeBin, version },
    node: process.version,
    host: { platform: os.platform(), arch: os.arch(), release: os.release() },
    models: opts.models,
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, covers: s.covers })),
    execution,
    coverage: catalog.coverage,
    counts,
    total: flat.length,
    gate,
    userSettings: {
      path: userSettingsPath,
      intact: userSettingsIntact,
      before: userSettingsBefore,
      after: userSettingsAfter,
    },
    // A run that rewrote the machine it ran on is not green, however many slots
    // passed. It is a separate failure from any slot's, so it is reported
    // separately rather than folded into the counts.
    green: counts.pass >= gate && userSettingsIntact,
    slotsFile: path.relative(ROOT_DIR, slotsPath),
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(
    `\npass ${counts.pass}  fail ${counts.fail}  blocked ${counts.blocked}  of ${flat.length}` +
      `   (gate: ${gate})`,
  );
  if (!userSettingsIntact) {
    console.log(
      `\n  FAILED: ${userSettingsPath} changed during the run.\n` +
        `  before ${userSettingsBefore}\n  after  ${userSettingsAfter}\n` +
        "  Every slot is handed its own --settings and CLAUDE_CONFIG_DIR; nothing here may touch the real one.",
    );
  }
  console.log(`artifacts: ${path.relative(ROOT_DIR, runDir)}`);
  console.log(`report:    node scripts/verify/report.mjs ${path.relative(ROOT_DIR, runDir)}`);

  return summary.green ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

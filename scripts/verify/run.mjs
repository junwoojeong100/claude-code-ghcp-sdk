#!/usr/bin/env node
/**
 * Verification runner: 10 scenarios x 7 primary Copilot models.
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
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRIMARY_MODELS, SCENARIOS, DEFAULT_PLAN, gateFor, planRun, validateCatalog } from "./scenarios.mjs";
import { DRIVERS } from "./drivers.mjs";
import { buildFixture } from "./fixtures.mjs";
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

async function runSlot({ model, scenario, runDir, claudeBin, keepWorkspaces }) {
  const slotId = `${model}__${scenario.id}`;
  const slotDir = path.join(runDir, "slots", slotId);
  const workspace = path.join(slotDir, "workspace");
  const configDir = path.join(slotDir, "config");
  const settingsPath = path.join(slotDir, "settings.json");
  const bridgeLog = path.join(slotDir, "bridge.log");

  fs.mkdirSync(slotDir, { recursive: true });
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
    bridge = await startBridge({ model, logPath: bridgeLog });
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
      timeoutSeconds: scenario.budgetSeconds,
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
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
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
  const plan = planRun({
    scenarios,
    models: opts.models,
    modelConcurrency: opts.modelConcurrency,
    scenarioConcurrency: opts.scenarioConcurrency,
  });

  console.log(`models:    ${opts.models.length}  (${opts.models.join(", ")})`);
  console.log(`scenarios: ${scenarios.length}`);
  console.log(`slots:     ${plan.slots}`);
  console.log(`coverage:  ${catalog.coverage.percent}% weighted of Claude Code core features`);
  console.log(`worst case ~${Math.round(plan.wallClockSeconds / 60)} min, peak ${plan.peakClaudeProcesses} Claude processes`);

  if (opts.dryRun) {
    console.log("\n--dry-run: no calls made.");
    return 0;
  }

  const claudeBin = resolveClaudeBin();
  const version = claudeVersion(claudeBin);
  console.log(`claude:    ${claudeBin} (${version})\n`);

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
    coverage: catalog.coverage,
    counts,
    total: flat.length,
    gate,
    green: counts.pass >= gate,
    slotsFile: path.relative(ROOT_DIR, slotsPath),
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(
    `\npass ${counts.pass}  fail ${counts.fail}  blocked ${counts.blocked}  of ${flat.length}` +
      `   (gate: ${gate})`,
  );
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

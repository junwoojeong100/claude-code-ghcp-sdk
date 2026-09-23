#!/usr/bin/env node
/**
 * Verification runner: the full scenario catalog x 6 primary Copilot models.
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
 *   node scripts/verify/run.mjs --models claude-opus-5.5 --scenarios v01-repo-recon
 *   node scripts/verify/run.mjs --dry-run
 *   PENDING_TOOL_WAIT_MS=30000 node scripts/verify/run.mjs --timeout-scale 2
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isEntryPoint } from "../../src/entry-point.mjs";
import { settingsFileState } from "../../src/settings-file-state.mjs";
import { PRIMARY_MODELS, SCENARIOS, DEFAULT_PLAN, planRun, validateCatalog } from "./scenarios.mjs";
import { coverage } from "./features.mjs";
import { assessRun, createRunDefinition, FINGERPRINT_SCOPE } from "./summary.mjs";
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

export function parseArgs(argv) {
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
  const list = (raw, flag) => {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`${flag} must contain nonempty, unique values.`);
    }
    // Do not filter empty entries: a trailing comma is an input error, not a
    // request for a smaller matrix.
    return raw.split(",").map((value) => value.trim());
  };
  const concurrency = (raw, flag) => {
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${flag} must be a positive safe integer.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--models") opts.models = list(next(), arg);
    else if (arg === "--scenarios") opts.scenarios = list(next(), arg);
    else if (arg === "--model-concurrency") opts.modelConcurrency = concurrency(next(), arg);
    else if (arg === "--scenario-concurrency") opts.scenarioConcurrency = concurrency(next(), arg);
    else if (arg === "--timeout-scale") opts.timeoutScale = parseTimeoutScale(next());
    else if (arg === "--out") {
      const value = next();
      if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
        throw new Error("--out requires a nonempty directory path.");
      }
      opts.outDir = path.resolve(value);
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--keep-workspaces") opts.keepWorkspaces = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  // Shared validation rejects empty, duplicate and unknown axis values before
  // resolving a binary, creating artifacts, querying git or making a call.
  createRunDefinition(opts.models, opts.scenarios);
  return opts;
}

/* ------------------------------------------------------------------ *
 * Local implementation provenance
 * ------------------------------------------------------------------ */

/** Local read-only git metadata and a deterministic working-tree code hash. */
export function captureCodeState(rootDir = ROOT_DIR, { artifactDir } = {}) {
  const git = (args) => {
    const result = spawnSync("git", ["--no-optional-locks", "-C", rootDir, ...args], {
      encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    });
    return result.status === 0 && !result.error ? result.stdout : null;
  };
  const commit = git(["rev-parse", "--verify", "HEAD"])?.trim() || null;
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const state = { git: { commit, dirty: status === null ? null : status.length > 0 }, fingerprint: null };
  const listed = git([
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "src/", "scripts/verify/", "bin/", "package.json", "package-lock.json", "npm-shrinkwrap.json",
  ]);
  if (listed === null) return state;

  const excluded = artifactDir ? path.resolve(artifactDir) : null;
  const files = [...new Set(listed.split("\0").filter(Boolean))].filter((name) => {
    const absolute = path.resolve(rootDir, name);
    if (excluded && (absolute === excluded || absolute.startsWith(`${excluded}${path.sep}`))) return false;
    // Logs, documents and generated run evidence are not implementation. Git's
    // list includes relevant new untracked code, but omits ignored artifacts.
    if (name.split("/").some((part) => part === ".verify-runs" || part === "node_modules")) return false;
    if (name.startsWith("bin/")) return !/\.(?:log|jsonl|md|txt)$/i.test(name);
    return /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|sh)$/.test(name);
  }).sort();
  try {
    const hash = createHash("sha256").update(`${FINGERPRINT_SCOPE}\0`);
    for (const name of files) {
      const file = path.join(rootDir, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        hash.update(JSON.stringify([name, "missing"]) + "\n");
        continue;
      }
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "unsupported";
      if (kind === "unsupported") throw new Error(`Cannot fingerprint ${name}`);
      // Never follow a symlink outside the checkout; hash its target spelling.
      const bytes = kind === "symlink" ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
      hash.update(JSON.stringify([name, kind, stat.mode & 0o111, bytes.length]) + "\n");
      hash.update(bytes).update("\0");
    }
    state.fingerprint = { algorithm: "sha256", scope: FINGERPRINT_SCOPE, value: hash.digest("hex"), files: files.length };
  } catch {
    // Missing/unreadable provenance must never turn an all-pass tally green.
    state.fingerprint = null;
  }
  return state;
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
  const definition = createRunDefinition(opts.models, scenarios);
  const selectedCoverage = coverage(scenarios);
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
  console.log(`slots:     ${definition.expectedTotal}`);
  console.log(`scope:     ${definition.scope.kind} (${definition.expectedTotal}/${definition.scope.fullMatrixTotal} catalogue slots)`);
  console.log(`policy:    ${definition.policy.id} (100% of the exact selected matrix must pass)`);
  console.log(`coverage:  ${selectedCoverage.percent}% weighted of Claude Code core features (selected scenarios; not a pass rate)`);
  console.log(`single-turn scheduling estimate ~${Math.round(plan.wallClockSeconds / 60)} min, peak ${plan.peakClaudeProcesses} Claude processes`);
  console.log("Planning estimate only, not a deadline or worst-case bound; extra turns, startup and cleanup can take longer.");
  console.log(`execution: ${JSON.stringify(execution)}`);

  if (opts.dryRun) {
    console.log("\n--dry-run: no calls made.");
    return 0;
  }

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, stamp);
  const codeBefore = captureCodeState(ROOT_DIR, { artifactDir: runDir });

  // Every slot has isolated settings. Read only a digest of the user's real
  // settings before and after; never store their contents or use them in a slot.
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const userSettingsBefore = settingsFileState(userSettingsPath);
  const claudeBin = resolveClaudeBin();
  const version = claudeVersion(claudeBin);
  console.log(`claude:    ${claudeBin} (${version})\n`);

  fs.mkdirSync(path.join(runDir, "slots"), { recursive: true });
  const slotsPath = path.join(runDir, "slots.jsonl");
  const summaryPath = path.join(runDir, "summary.json");
  const summary = {
    ...definition,
    startedAt: new Date(startedAt).toISOString(),
    claude: { bin: claudeBin, version },
    node: process.version,
    host: { platform: os.platform(), arch: os.arch(), release: os.release() },
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, covers: s.covers })),
    execution,
    coverage: selectedCoverage,
    actualTotal: 0,
    total: 0,
    gate: definition.expectedTotal,
    green: false,
    userSettings: { path: userSettingsPath, before: userSettingsBefore, after: null, intact: null },
    provenance: { start: codeBefore, end: null },
    slotsFile: path.relative(ROOT_DIR, slotsPath),
  };
  // Persist the expected matrix before work starts. An interrupted run keeps
  // its denominator, but absent end-state evidence can never imply success.
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  const slotStream = fs.createWriteStream(slotsPath, { flags: "a" });

  let done = 0;
  const total = definition.expectedTotal;

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

  const userSettingsAfter = settingsFileState(userSettingsPath);
  Object.assign(summary, {
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    actualTotal: flat.length,
    total: flat.length,
    userSettings: {
      path: userSettingsPath,
      intact: userSettingsBefore === userSettingsAfter,
      before: userSettingsBefore,
      after: userSettingsAfter,
    },
    provenance: { start: codeBefore, end: captureCodeState(ROOT_DIR, { artifactDir: runDir }) },
  });
  const assessment = assessRun(summary, flat);
  Object.assign(summary, {
    counts: assessment.counts,
    gate: assessment.gate,
    green: assessment.green,
    assessment,
  });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  const { counts, gate } = assessment;
  console.log(
    `\npass ${counts.pass}  fail ${counts.fail}  blocked ${counts.blocked}  unknown ${counts.unknown}` +
      `  expected ${assessment.expectedTotal}  actual ${assessment.actualTotal}   (gate: ${gate})`,
  );
  console.log(`result: ${assessment.green ? "PASS" : "NOT GREEN"} (${assessment.scope.kind})`);
  for (const problem of assessment.problems) console.log(`  FAILED: ${problem}`);
  console.log(`provenance: ${JSON.stringify(summary.provenance)}`);
  console.log(`artifacts: ${path.relative(ROOT_DIR, runDir)}`);
  console.log(`report:    node scripts/verify/report.mjs ${path.relative(ROOT_DIR, runDir)}`);

  return summary.green ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

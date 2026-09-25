#!/usr/bin/env node
/** Real CLI → private bridge → Copilot. One sequential scenario lane per model. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEntryPoint } from "../../src/entry-point.mjs";
import { settingsFileState } from "../../src/settings-file-state.mjs";
import { PRIMARY_MODELS, SCENARIOS, SCENARIO_IDS, switchSource } from "./scenarios.mjs";
import { assessRun, createRunDefinition, FINGERPRINT_SCOPE, slotEvidenceProblems } from "./summary.mjs";
import { readCopilotSdkVersion } from "./sdk-version.mjs";
import { createTimeoutPolicy, parseTimeoutScale, runtimeTimeouts } from "./timeouts.mjs";
import { ROOT_DIR, claudeVersion, resolveClaudeBin, seedConfigDir, startBridge, writeLaunchSettings } from "./bridge.mjs";

const HELP = `Usage: node scripts/verify/run.mjs [options]
  --models <comma-separated primary IDs>  Focused debug selection
  --scenarios <comma-separated V01..V06>   Focused debug selection
  --model-concurrency <positive integer>  Default: 1; scenarios stay sequential
  --timeout-scale <positive number>       Scale total slot/startup/cleanup budgets
  --out <directory>                       Parent for a new immutable run
  --keep-workspaces                      Retain successful temporary workspaces
  --dry-run                              Selection only; no writes/spawn/binary lookup
  --help                                 Show this help
Full success requires V01–V06 × all six models (36 slots).
`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const writeJSON = (file, value, flag = "wx") => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag, mode: 0o600 });
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const opts = { models: [...PRIMARY_MODELS], scenarios: [...SCENARIO_IDS], modelConcurrency: 1,
    timeoutScale: 1, outDir: path.join(ROOT_DIR, ".verify-runs"), dryRun: false, keepWorkspaces: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    if (arg === "--models" || arg === "--scenarios") {
      const raw = next();
      if (typeof raw !== "string" || !raw.trim()) throw new Error(`${arg} must contain nonempty, unique values.`);
      opts[arg.slice(2)] = raw.split(",").map(v => v.trim());
    } else if (arg === "--model-concurrency") {
      const raw = next(), value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} must be a positive safe integer.`);
      opts.modelConcurrency = value;
    } else if (arg === "--timeout-scale") opts.timeoutScale = parseTimeoutScale(next());
    else if (arg === "--out") {
      const value = next();
      if (!value?.trim() || value.startsWith("--")) throw new Error("--out requires a nonempty directory path.");
      opts.outDir = path.resolve(value);
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--keep-workspaces") opts.keepWorkspaces = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  createRunDefinition(opts.models, opts.scenarios);
  return opts;
}

function gitRead(root, args) {
  const result = spawnSync("git", ["--no-optional-locks", "-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 && !result.error ? result.stdout : null;
}
export function fingerprintEntries(entries) {
  return hash(`${FINGERPRINT_SCOPE}\0${entries.map(({ path: name, kind, executable, bytes, sha256 }) => JSON.stringify([name, kind, executable, bytes, sha256])).join("\n")}\n`);
}

/** Freeze actual dirty implementation/tests/fixtures, never .env, old evidence or docs. */
export function captureCodeState(rootDir = ROOT_DIR, { artifactDir, freeze = false } = {}) {
  const status = gitRead(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const state = { git: { commit: gitRead(rootDir, ["rev-parse", "--verify", "HEAD"])?.trim() || null, dirty: status === null ? null : Boolean(status) }, fingerprint: null };
  const listed = gitRead(rootDir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "src/", "scripts/verify/", "bin/", "test/", "package.json", "package-lock.json", "npm-shrinkwrap.json"]);
  if (listed === null) return state;
  const entries = [], excluded = artifactDir && path.resolve(artifactDir);
  try {
    const names = [...new Set(listed.split("\0").filter(Boolean))].filter(name => {
      if (path.isAbsolute(name) || name.split("/").some(p => ["..", ".verify-runs", "node_modules", "__pycache__"].includes(p))) return false;
      if (excluded && inside(excluded, path.resolve(rootDir, name))) return false;
      if (name.startsWith("bin/")) return !/\.(?:log|jsonl|md|txt)$/i.test(name);
      if (name.startsWith("test/fixtures/")) return /\.(?:[cm]?js|[cm]?ts|py|json|txt|sh)$/.test(name);
      return /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|sh|py)$/.test(name);
    }).sort();
    for (const name of names) {
      const file = path.join(rootDir, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        entries.push({ path: name, kind: "missing", executable: 0, bytes: 0, sha256: null }); continue;
      }
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "unsupported";
      if (kind === "unsupported") throw new Error(`Cannot fingerprint ${name}`);
      const bytes = kind === "symlink" ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
      const entry = { path: name, kind, executable: stat.mode & 0o111, bytes: bytes.length, sha256: hash(bytes) };
      if (freeze) {
        if (!artifactDir) throw new Error("Source freeze requires artifactDir.");
        entry.copy = `sources/files/${name}${kind === "symlink" ? ".symlink-target" : ""}`;
        const target = path.join(artifactDir, entry.copy);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 | entry.executable });
      }
      entries.push(entry);
    }
    state.fingerprint = { algorithm: "sha256", scope: FINGERPRINT_SCOPE, value: fingerprintEntries(entries), files: entries.length };
    if (freeze) {
      const manifest = "sources/manifest.json";
      fs.mkdirSync(path.join(artifactDir, "sources"), { recursive: true, mode: 0o700 });
      writeJSON(path.join(artifactDir, manifest), { schemaVersion: 2, fingerprint: state.fingerprint, entries });
      state.sources = { path: manifest, sha256: fileHash(path.join(artifactDir, manifest)) };
    }
  } catch (error) { state.fingerprint = null; state.error = error.message; }
  return state;
}

export function captureReference(rootDir = ROOT_DIR) {
  const root = path.resolve(rootDir, "../openai-codex-ghcp-sdk");
  const files = ["scripts/verification/catalog.mjs", "scripts/verification/scenarios.mjs"];
  return { root, commit: gitRead(root, ["rev-parse", "--verify", "HEAD"])?.trim() || null,
    files: files.map(name => { try { return { path: name, sha256: fileHash(path.join(root, name)) }; } catch { return { path: name, sha256: null }; } }) };
}

/** Hash all run-local evidence without dereferencing any symlink. */
export function sealArtifacts(runDir) {
  const entries = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(runDir, file).split(path.sep).join("/");
      if (["summary.json", "artifact-manifest.json"].includes(relative) || relative === "sources") continue;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) entries.push({ path: relative, kind: "file", bytes: stat.size, sha256: fileHash(file) });
      else if (stat.isSymbolicLink()) { const bytes = Buffer.from(fs.readlinkSync(file)); entries.push({ path: relative, kind: "symlink", bytes: bytes.length, sha256: hash(bytes) }); }
      else throw new Error(`Unsupported evidence file: ${relative}`);
    }
  };
  walk(runDir);
  writeJSON(path.join(runDir, "artifact-manifest.json"), { schemaVersion: 2, entries });
  return { slots: { path: "slots.jsonl", sha256: fileHash(path.join(runDir, "slots.jsonl")) },
    manifest: { path: "artifact-manifest.json", sha256: fileHash(path.join(runDir, "artifact-manifest.json")) } };
}

function blockedPhases(scenario, reason) {
  return Object.fromEntries(scenario.phases.map(p => [p.id, { outcome: "blocked", reason,
    checks: [{ name: "required phase ran", ok: false, outcome: "blocked", detail: reason }], requestedModels: [], sdk: { servedModels: [], records: [], responseIds: [] } }]));
}
function blockedSlot(model, scenario, reason) {
  const now = new Date().toISOString();
  return { slotId: `${model}__${scenario.id}`, model, scenario: scenario.id, outcome: "blocked", reason,
    startedAt: now, finishedAt: now, durationMs: 0, checks: [{ name: "slot available", ok: false, outcome: "blocked", detail: reason }],
    cleanup: { ok: true, bridges: [] }, evidence: { phases: blockedPhases(scenario, reason) } };
}
const explicitBreach = record => record.safetyBreach === true || record.evidence?.safetyBreach === true || record.cleanup?.ok === false ||
  record.evidence?.isolation?.ok === false || record.evidence?.settings?.ok === false ||
  record.evidence?.cleanup?.launches?.some(l => l?.ok === false);

export async function runSlot({ model, scenario, runDir, claudeBin, version, preflight, keepWorkspaces, timeouts,
  expectedRuntimeTimeouts = runtimeTimeouts(), rootDir = ROOT_DIR, env = process.env }, deps = {}) {
  const slotId = `${model}__${scenario.id}`, slotDir = path.join(runDir, "slots", slotId);
  fs.mkdirSync(slotDir, { recursive: true, mode: 0o700 });
  const slotTmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "verify-essential-"));
  const workspace = path.join(slotTmp, "workspace"), configDir = path.join(slotDir, "home", ".claude");
  const startedAt = Date.now(), deadline = startedAt + timeouts.scenarioMs[scenario.id];
  const record = { slotId, model, scenario: scenario.id, startedAt: new Date(startedAt).toISOString(), deadline };
  const controller = new AbortController(), bridges = [], receipts = [], settingsFiles = [];
  const timer = setTimeout(() => controller.abort(new Error("Total slot deadline exceeded")), Math.max(1, deadline - Date.now()));
  let bridge, settingsPath, activeWork;
  const addCheck = (name, ok, detail, outcome = "fail") => {
    record.checks ??= []; record.checks.push({ name, ok, outcome: ok ? "pass" : outcome, detail });
    if (!ok && (outcome === "fail" || record.outcome !== "fail")) record.outcome = outcome;
  };
  const stop = async current => {
    if (receipts.some(r => r.bridge === current)) return receipts.find(r => r.bridge === current).receipt;
    let receipt;
    try { receipt = await current.stop(); } catch (error) { receipt = { ok: false, reason: error.message, pid: current.pid }; }
    if (receipt?.ok !== true) receipt = { ...receipt, ok: false, reason: receipt?.reason ?? "missing successful bridge cleanup receipt" };
    receipts.push({ bridge: current, receipt }); return receipt;
  };
  const launch = async initialModel => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error("Total slot deadline exceeded before bridge startup");
    const index = bridges.length, logPath = path.join(slotDir, index ? `bridge-${index + 1}.log` : "bridge.log");
    const current = await (deps.startBridge ?? startBridge)({ model: initialModel, logPath, rootDir, env,
      healthTimeoutMs: Math.min(timeouts.bridgeHealthMs, deadline - Date.now()), cleanupTimeoutMs: timeouts.cleanupMs, signal: controller.signal });
    bridges.push(current);
    record.bridges ??= []; record.bridges.push({ ...current.metadata, pid: current.pid, port: current.port, health: current.health, logPath });
    const actual = current.health?.timeouts;
    if (!actual || Object.entries(expectedRuntimeTimeouts).some(([key, ms]) => actual[key] !== ms)) throw new Error("Bridge /health timeout budgets missing or differ from recorded runtime configuration");
    const file = path.join(slotDir, index ? `settings-${index + 1}.json` : "settings.json");
    (deps.writeLaunchSettings ?? writeLaunchSettings)({ bridge: current, settingsPath: file, rootDir, env });
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    settings.autoMemoryEnabled = false; settings.disableAllHooks = true;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 }); fs.chmodSync(file, 0o600);
    settingsFiles.push({ path: file, before: fileHash(file) });
    return { bridge: current, settingsPath: file };
  };
  try {
    if (inside(fs.realpathSync(rootDir), fs.realpathSync(slotTmp))) throw new Error("Workspace must be outside the checkout");
    (deps.seedConfigDir ?? seedConfigDir)(configDir, { version });
    ({ bridge, settingsPath } = await launch(scenario.id === "V04" ? switchSource(model) : model));
    record.frontendModel = bridge.frontendModel;
    const drivers = deps.DRIVERS ?? (await import("./drivers.mjs")).DRIVERS;
    const buildFixture = deps.buildFixture ?? (await import("./fixtures.mjs")).buildFixture;
    const ctx = { scenario, model, frontendModel: bridge.frontendModel, bridge, workspace, fixture: buildFixture(scenario.id, workspace),
      settingsPath, configDir, claudeBin, slotDir, deadline, signal: controller.signal, preflight,
      timeoutSeconds: timeouts.scenarioMs[scenario.id] / 1000, timeouts,
      restartBridge: async () => {
        if (scenario.id !== "V06") throw new Error("Bridge restart is only declared for V06");
        const cleanup = await stop(bridge);
        if (!cleanup.ok) { record.safetyBreach = true; throw new Error("Old bridge cleanup failed; replacement refused"); }
        const next = await launch(model); bridge = next.bridge; settingsPath = next.settingsPath;
        return { ...next, cleanup };
      } };
    activeWork = Promise.resolve().then(() => drivers[scenario.id](ctx)).then(value => ({ value }), error => ({ error }));
    let expire;
    const aborted = new Promise(resolve => { expire = () => resolve({ expired: true }); controller.signal.addEventListener("abort", expire, { once: true }); if (controller.signal.aborted) expire(); });
    const result = await Promise.race([activeWork, aborted]);
    controller.signal.removeEventListener("abort", expire);
    if (result.expired) {
      let settleTimer;
      const settled = await Promise.race([activeWork, new Promise(resolve => { settleTimer = setTimeout(() => resolve(null), timeouts.cleanupMs); })]);
      clearTimeout(settleTimer);
      if (settled?.value) Object.assign(record, settled.value);
      if (!settled) record.safetyBreach = true;
      addCheck("total slot deadline", false, "Total slot budget exhausted; no phase receives a fresh budget", "blocked");
      record.reason = "Total slot deadline exceeded";
    } else if (result.error) throw result.error;
    else Object.assign(record, result.value);
  } catch (error) {
    record.outcome = record.outcome === "fail" ? "fail" : "blocked";
    record.reason = `${error.name ?? "Error"}: ${error.message}`;
    record.checks ??= []; record.checks.push({ name: "harness execution", ok: false, outcome: "blocked", detail: record.reason });
    if (error.cleanup) { receipts.push({ bridge: null, receipt: error.cleanup }); if (!error.cleanup.ok) record.safetyBreach = true; }
  } finally {
    clearTimeout(timer); controller.abort();
    for (const current of bridges) await stop(current);
    record.cleanup = { ok: receipts.every(r => r.receipt?.ok === true), bridges: receipts.map(r => r.receipt) };
    record.evidence ??= {}; record.evidence.phases ??= {};
    for (const [label, phase] of Object.entries(blockedPhases(scenario, record.reason || "Required phase did not run"))) record.evidence.phases[label] ??= phase;
    const files = settingsFiles.map(entry => { try { return { ...entry, after: fs.lstatSync(entry.path).isFile() ? fileHash(entry.path) : null }; } catch { return { ...entry, after: null }; } });
    record.evidence.settings = { ok: files.every(f => f.before === f.after), files };
    if (!record.cleanup.ok) addCheck("owned bridge cleanup", false, "Owned process group or port not released");
    if (!record.evidence.settings.ok) addCheck("launch settings immutable", false, "Private settings changed");
    if (explicitBreach(record)) record.safetyBreach = true;
    if (record.outcome === "pass") {
      const missing = slotEvidenceProblems(record, scenario);
      if (missing.length) { addCheck("complete evidence", false, missing.join("; "), "blocked"); record.reason = missing.join("; "); }
    }
    if (!keepWorkspaces && record.outcome === "pass" && !record.safetyBreach) fs.rmSync(slotTmp, { recursive: true, force: true });
    else {
      record.workspace = workspace;
      if (!record.safetyBreach && fs.existsSync(workspace)) {
        const { preserveWorkspace } = await import("./workspace-evidence.mjs");
        record.evidence.workspaceArchive = preserveWorkspace(workspace, path.join(slotDir, "workspace.json"));
      }
    }
  }
  record.durationMs = Date.now() - startedAt; record.finishedAt = new Date().toISOString();
  return record;
}

async function pool(items, concurrency, worker) {
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; results[i] = await worker(items[i]); }
  }));
  return results.flat();
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv), log = deps.log ?? console.log;
  if (opts.help) { log(HELP); return 0; }
  const definition = createRunDefinition(opts.models, opts.scenarios), scenarios = definition.scenarios;
  const env = deps.env ?? process.env, rootDir = deps.rootDir ?? ROOT_DIR;
  const timeouts = createTimeoutPolicy(scenarios, opts.timeoutScale), runtime = runtimeTimeouts(env);
  const execution = { modelConcurrency: opts.modelConcurrency, pendingToolWaitMs: runtime.pendingToolWaitMs, timeouts, runtimeTimeouts: runtime, observationEnabled: true };
  log(`models:    ${opts.models.length} (${opts.models.join(", ")})`);
  log(`scenarios: ${opts.scenarios.join(", ")}\nslots:     ${definition.expectedTotal}\nscope:     ${definition.scope.kind} (${definition.expectedTotal}/36 cases)\npolicy:    ${definition.policy.id}\nexecution: ${JSON.stringify(execution)}`);
  if (opts.dryRun) { log("--dry-run: no artifacts, subprocesses, SDK metadata or model calls; binary/auth/connectivity not checked."); return 0; }
  const startedAt = Date.now(), runDir = path.join(opts.outDir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(opts.outDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(runDir, { mode: 0o700 });
  fs.mkdirSync(path.join(runDir, "slots"), { mode: 0o700 });
  const capture = deps.captureCodeState ?? captureCodeState;
  const codeBefore = capture(rootDir, { artifactDir: runDir, freeze: true });
  const settingsPath = deps.userSettingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  const settingsBefore = settingsFileState(settingsPath);
  const summary = { ...definition, mode: "live", startedAt: new Date(startedAt).toISOString(), execution,
    claude: {}, copilotSdk: { version: (deps.readCopilotSdkVersion ?? readCopilotSdkVersion)() }, node: process.version,
    host: { platform: os.platform(), arch: os.arch(), release: os.release() }, actualTotal: 0, total: 0, gate: definition.expectedTotal, green: false,
    reference: (deps.captureReference ?? captureReference)(rootDir), provenance: { start: codeBefore, end: null, sources: codeBefore.sources },
    userSettings: { path: settingsPath, before: settingsBefore, after: null, intact: null }, slotsFile: "slots.jsonl" };
  const summaryPath = path.join(runDir, "summary.json"), slotsPath = path.join(runDir, "slots.jsonl");
  writeJSON(summaryPath, summary); fs.writeFileSync(slotsPath, "", { flag: "wx", mode: 0o600 });
  let preflight, globalBlock = null, safetyStop = null;
  try {
    const bin = (deps.resolveClaudeBin ?? resolveClaudeBin)({ rootDir, env }), realpath = fs.realpathSync(bin);
    const sha256 = fileHash(realpath), version = (deps.claudeVersion ?? claudeVersion)(realpath);
    summary.claude = { bin, realpath, sha256, version };
    const preflightCLI = deps.preflightCLI ?? (await import("./preflight.mjs")).preflightCLI;
    preflight = await preflightCLI({ claudeBin: realpath, directory: path.join(runDir, "preflight") });
    summary.preflight = preflight;
    const identity = preflight?.claude;
    if (!identity || identity.bin !== realpath || identity.sha256 !== sha256 || identity.version !== version || fileHash(realpath) !== sha256) globalBlock = "Preflight CLI identity does not match pinned binary/version/hash";
    if (preflight?.cleanup?.ok === false) safetyStop = "Preflight cleanup failed";
    if (!codeBefore.fingerprint || !codeBefore.sources) globalBlock = "Source freeze failed; live execution refused";
  } catch (error) { globalBlock = `Preflight unavailable: ${error.name}: ${error.message}`; summary.preflight = { ok: false, reason: globalBlock }; }
  // Startup metadata is not a completed verdict; record preflight before workers.
  writeJSON(summaryPath, summary, "w");
  let done = 0;
  const records = await pool(opts.models, opts.modelConcurrency, async model => {
    const lane = [];
    for (const scenario of scenarios) {
      let reason = safetyStop || globalBlock;
      if (!reason && preflight?.scenarios?.[scenario.id]?.ok !== true) reason = preflight?.scenarios?.[scenario.id]?.reason || `Preflight capability unavailable for ${scenario.id}`;
      if (!reason && fileHash(summary.claude.realpath) !== summary.claude.sha256) { reason = "Pinned CLI binary changed before slot"; safetyStop = reason; }
      const record = reason ? blockedSlot(model, scenario, reason) : await (deps.runSlot ?? runSlot)({ model, scenario, runDir,
        claudeBin: summary.claude.realpath, version: summary.claude.version, preflight, keepWorkspaces: opts.keepWorkspaces,
        timeouts, expectedRuntimeTimeouts: runtime, rootDir, env }, deps);
      if (explicitBreach(record)) safetyStop ||= `Isolation or cleanup breach in ${model} × ${scenario.id}`;
      lane.push(record); fs.appendFileSync(slotsPath, JSON.stringify(record) + "\n");
      log(`[${++done}/${definition.expectedTotal}] ${String(record.outcome).toUpperCase()} ${model} ${scenario.id} ${Math.round(record.durationMs / 1000)}s${record.reason ? `\n  ${record.reason}` : ""}`);
    }
    return lane;
  });
  try { summary.claude.endSha256 = fileHash(summary.claude.realpath); } catch { summary.claude.endSha256 = null; }
  const settingsAfter = settingsFileState(settingsPath);
  Object.assign(summary, { finishedAt: new Date().toISOString(), durationSeconds: Math.round((Date.now() - startedAt) / 1000), actualTotal: records.length, total: records.length,
    cleanup: { ok: records.every(r => r.cleanup?.ok === true) && preflight?.cleanup?.ok !== false }, safetyStop,
    userSettings: { path: settingsPath, before: settingsBefore, after: settingsAfter, intact: settingsBefore === settingsAfter },
    provenance: { start: codeBefore, end: capture(rootDir, { artifactDir: runDir }), sources: codeBefore.sources }, artifacts: sealArtifacts(runDir) });
  const assessment = assessRun(summary, records);
  Object.assign(summary, { counts: assessment.counts, gate: assessment.gate, green: assessment.green, assessment });
  writeJSON(summaryPath, summary, "w");
  log(`\npass ${assessment.counts.pass}  fail ${assessment.counts.fail}  blocked ${assessment.counts.blocked}  unknown ${assessment.counts.unknown}  expected ${assessment.expectedTotal}  actual ${assessment.actualTotal}`);
  log(`result: ${assessment.green ? assessment.scope.kind === "full" ? "PASS" : "FOCUSED PASS (not a full pass)" : "NOT PASSED"}`);
  for (const problem of assessment.problems) log(`  FAILED: ${problem}`);
  log(`artifacts: ${runDir}\nreport:    npm run verify:report -- '${runDir.replaceAll("'", "'\\''")}'`);
  return assessment.green ? 0 : 1;
}
if (isEntryPoint(import.meta.url)) main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });

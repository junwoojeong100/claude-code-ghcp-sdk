/**
 * Bridge and Claude Code lifecycle for one verification slot.
 *
 * Each slot gets its own bridge process, loopback port and token. Sharing one
 * bridge across concurrent slots would let a rate-limit stall in one scenario
 * read as a failure in another.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TIMEOUTS } from "./timeouts.mjs";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bridge knobs a live result could depend on but that /health does not report,
// so a run always uses the shipped defaults. The timeout budgets stay: the
// runner records them and compares them with each bridge's /health.
export const UNRECORDED_BRIDGE_KNOBS = Object.freeze(["MAX_BODY_BYTES", "MAX_REPLAY_BYTES", "MAX_STATES", "MAX_TOOL_RESULTS",
  "RETIRED_IDLE_MS", "ALLOW_NON_LOOPBACK", "COPILOT_SDK_DEFAULT_CONNECTION"]);

/** Child-only isolation: keep Copilot credentials and recorded runtime budgets. */
export function cleanVerificationEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:ANTHROPIC_|CLAUDE|BRIDGE_|GHCP_|OPENAI_|AZURE_OPENAI_)/.test(key) &&
    !["ENABLE_TOOL_SEARCH", "NODE_OPTIONS", ...UNRECORDED_BRIDGE_KNOBS].includes(key)));
}

// Cold startup includes SDK initialization. Each health request is bounded too,
// so an unresponsive loopback port cannot defeat the overall startup budget.
const HEALTH_TIMEOUT_MS = DEFAULT_TIMEOUTS.bridgeHealthMs;
const HEALTH_POLL_MS = 200;
// Well above a loopback /health round-trip (milliseconds) and well below the
// budget, so a bridge that is merely busy is retried rather than written off.
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export class BridgeStartupError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BridgeStartupError";
    Object.assign(this, details);
  }
}

export class ClaudeBinaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeBinaryError";
  }
}

/* ------------------------------------------------------------------ *
 * Claude Code binary
 * ------------------------------------------------------------------ */

function canonical(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function whichAll(name, env) {
  const found = [];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) found.push(candidate);
  }
  return found;
}

const WRAPPERS = new Set(["claude", "claude-ghcp", "claude-litellm", "claude-current"]);

/**
 * Port of bin/resolve-claude.sh.
 *
 * This repo's own bin/ is on PATH during development and those wrappers
 * re-invoke the launcher, so resolving to one would fork-bomb. A wrapper is
 * recognised by name and by the resolve-claude.sh beside it, which catches
 * every checkout's launchers and not only rootDir's: run from a worktree with
 * the main checkout's bin/ on PATH, matching rootDir alone resolved to the main
 * checkout's bin/claude, and every slot of that matrix was blocked by that
 * launcher's own --settings guard.
 */
export function resolveClaudeBin({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const isWrapper = (candidate) => {
    const real = canonical(candidate);
    return (
      real !== null &&
      WRAPPERS.has(path.basename(real)) &&
      fs.existsSync(path.join(path.dirname(real), "resolve-claude.sh"))
    );
  };

  const explicit = env.CLAUDE_CODE_BIN;
  if (explicit) {
    const candidate = explicit.includes("/") ? explicit : whichAll(explicit, env)[0];
    if (!candidate || !isExecutable(candidate)) {
      throw new ClaudeBinaryError(`CLAUDE_CODE_BIN is not executable: ${explicit}`);
    }
    if (isWrapper(candidate)) {
      throw new ClaudeBinaryError(
        `CLAUDE_CODE_BIN must point at the real Claude Code executable, not ${candidate}.`,
      );
    }
    return candidate;
  }

  for (const candidate of whichAll("claude", env)) {
    if (isWrapper(candidate)) continue;
    return candidate;
  }
  throw new ClaudeBinaryError(
    `Claude Code executable not found outside this repo's launchers (${rootDir}/bin). ` +
      "Install Claude Code or set CLAUDE_CODE_BIN.",
  );
}

export function claudeVersion(bin = resolveClaudeBin()) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", env: cleanVerificationEnv(), timeout: 10000 });
  return (result.stdout ?? "").trim().split(/\s+/)[0] || "unknown";
}

/* ------------------------------------------------------------------ *
 * Bridge lifecycle
 * ------------------------------------------------------------------ */

export async function pickFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function probeHealth(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function waitForHealth(port, { timeoutMs = HEALTH_TIMEOUT_MS, isAlive, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted || (isAlive && !isAlive())) return null;
    const health = await probeHealth(port, Math.min(HEALTH_PROBE_TIMEOUT_MS, deadline - Date.now()));
    if (health?.ok && !signal?.aborted && (!isAlive || isAlive())) return health;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(HEALTH_POLL_MS, remaining)));
  }
  return null;
}

function spawnSyncCapture(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

/** Resolve the Claude-Code-facing model id for a Copilot model id. */
export function frontendModelFor(model, { rootDir = ROOT_DIR } = {}) {
  const result = spawnSyncCapture(
    process.execPath,
    [path.join(rootDir, "src", "model-cli.mjs"), "frontend", model],
    { cwd: rootDir, env: cleanVerificationEnv(), timeout: 10000 },
  );
  if (result.status !== 0) {
    throw new BridgeStartupError(
      `Could not resolve frontend model for ${model}: ${(result.stderr ?? "").trim()}`,
      { model },
    );
  }
  return result.stdout.trim();
}

export function readTail(filePath, bytes = 4000) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function portReleased(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function startBridge({
  model, logPath, rootDir = ROOT_DIR, env = process.env, logLevel = "error",
  healthTimeoutMs = HEALTH_TIMEOUT_MS, cleanupTimeoutMs = 7000, signal,
  spawnProcess = spawn,
}) {
  if (!model) throw new BridgeStartupError("startBridge requires a model.");
  if (signal?.aborted) throw new BridgeStartupError("Slot aborted before bridge startup.");
  const startedAt = Date.now();
  const port = await pickFreePort();
  const token = randomBytes(24).toString("hex");
  const frontendModel = frontendModelFor(model, { rootDir });
  const instanceId = `verify-${model}-${port}-${randomBytes(6).toString("hex")}`;
  const grouped = process.platform !== "win32";
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath, "wx", 0o600);
  let child, exited = null, spawnError = null, stopping, overflow = false;
  const groupAlive = () => {
    if (!child?.pid) return false;
    if (!grouped) return exited === null;
    try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  };
  const killOwned = (sig) => {
    if (!child?.pid) return;
    if (grouped) { try { process.kill(-child.pid, sig); return; } catch {} }
    if (!exited) { try { child.kill(sig); } catch {} }
  };
  let monitor;
  const stop = () => stopping ??= (async () => {
    const begin = Date.now();
    clearInterval(monitor);
    signal?.removeEventListener("abort", onAbort);
    killOwned("SIGTERM");
    while (groupAlive() && Date.now() - begin < Math.min(5000, cleanupTimeoutMs / 2)) await pause(25);
    if (groupAlive()) killOwned("SIGKILL");
    while (groupAlive() && Date.now() - begin < cleanupTimeoutMs) await pause(25);
    const groupGone = !groupAlive();
    const released = await portReleased(port);
    try { fs.closeSync(logFd); } catch {}
    if (!groupGone) child?.unref();
    return { ok: groupGone && released, pid: child?.pid ?? null, processGroup: grouped ? child?.pid ?? null : null,
      groupGone, portReleased: released, port, code: exited?.code ?? null, signal: exited?.signal ?? null,
      spawnError: spawnError?.message ?? null, logOverflow: overflow, durationMs: Date.now() - begin };
  })();
  const onAbort = () => { void stop(); };
  try {
    child = spawnProcess(process.execPath, [path.join(rootDir, "src", "server.mjs")], {
      cwd: rootDir, detached: grouped, windowsHide: true, stdio: ["ignore", logFd, logFd],
      env: { ...cleanVerificationEnv(env), HOST: "127.0.0.1", PORT: String(port),
        BRIDGE_API_KEY: token, BRIDGE_INSTANCE_ID: instanceId, BRIDGE_VERIFY_OBSERVE: "1",
        BRIDGE_ALLOW_UNAUTHENTICATED: "0", GHCP_MODEL: model, LOG_LEVEL: logLevel },
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", (code, sig) => { exited = { code, signal: sig }; });
  } catch (error) { spawnError = error; }
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  monitor = setInterval(() => {
    try { if (fs.statSync(logPath).size > 16 * 1024 * 1024) { overflow = true; void stop(); } } catch {}
  }, 250);
  const health = await waitForHealth(port, { timeoutMs: Math.max(1, healthTimeoutMs - (Date.now() - startedAt)),
    isAlive: () => !spawnError && !exited && !overflow, signal });
  if (!health || health.instanceId !== instanceId) {
    const cleanup = await stop();
    throw new BridgeStartupError(spawnError ? `Bridge spawn failed: ${spawnError.message}` :
      `Bridge for ${model} did not become healthy with its owned instance ID within ${healthTimeoutMs}ms.`,
    { model, cleanup, log: readTail(logPath, 2000) });
  }
  return { model, frontendModel, port, token, baseUrl: `http://127.0.0.1:${port}`, logPath, health,
    pid: child.pid, metadata: { instanceId, pid: child.pid, processGroup: grouped ? child.pid : null,
      observationEnabled: true, rootDir, startedAt: new Date(startedAt).toISOString() },
    isAlive: () => !exited && !spawnError && !overflow, stop };
}

/**
 * Write launch settings through the production writer, so each slot sees
 * exactly what bin/claude-ghcp would have written.
 */
export function writeLaunchSettings({ bridge, settingsPath, rootDir = ROOT_DIR, env = process.env }) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const result = spawnSyncCapture(
    process.execPath,
    [path.join(rootDir, "src", "write-launch-settings.mjs"), settingsPath, bridge.baseUrl, bridge.frontendModel],
    // The token never enters argv (process table); set after cleaning, which strips GHCP_*.
    { cwd: rootDir, env: { ...cleanVerificationEnv(env), GHCP_BRIDGE_TOKEN: bridge.token }, timeout: 10000 },
  );
  if (result.status !== 0) {
    throw new BridgeStartupError(
      `write-launch-settings failed for ${bridge.model}: ${(result.stderr ?? "").trim()}`,
      { model: bridge.model },
    );
  }
  return settingsPath;
}

/**
 * A throwaway CLAUDE_CONFIG_DIR that does not look like a fresh install.
 *
 * Per-slot isolation means Claude Code sees a brand-new config dir every time
 * and would otherwise spend the run on first-run onboarding.
 */
export function seedConfigDir(configDir, { version } = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const statePath = path.join(configDir, ".claude.json");
  const cliVersion = version ?? "2.0.0";
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        lastOnboardingVersion: cliVersion,
        lastReleaseNotesSeen: cliVersion,
        installMethod: "native",
        autoUpdates: false,
        numStartups: 25,
        theme: "dark",
      },
      null,
      2,
    ),
    "utf8",
  );
  return statePath;
}

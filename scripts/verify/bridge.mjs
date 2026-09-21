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

// A cold bridge boot makes three upstream Copilot round-trips inside
// manager.start() -- client.start(), listModels(), listSessions() -- before it
// ever reaches server.listen. Every slot killed at 45s left a 0-byte log, so
// none of them had got that far.
//
// This is a ceiling only because probeHealth aborts. A bare fetch carries no
// deadline of its own -- against a port that is bound but silent one was still
// pending at 20s, with undici's header timeout the only thing that would ever
// end it -- and waitForHealth compares the clock between probes, never during
// one, so a single probe used to outlast the whole budget. With the abort the
// worst case is the budget plus one unfinished iteration (a 2s probe and a
// 200ms poll): 122.2s at the default scale. waitForHealth's isAlive check gives up on a
// genuinely dead child in about a second, so the ceiling is only ever spent on
// a bridge that is alive but slow. It is not free in the schedule: planRun
// models no health wait at all, so wall clock now runs further ahead of the
// estimate than it did.
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

/**
 * Port of bin/resolve-claude.sh.
 *
 * This repo's own bin/ is on PATH during development and those wrappers
 * re-invoke the launcher, so resolving to one would fork-bomb. Any candidate
 * that canonicalises onto a repo wrapper is skipped.
 */
export function resolveClaudeBin({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const wrappers = new Set(
    ["claude", "claude-ghcp", "claude-litellm", "claude-current"]
      .map((name) => canonical(path.join(rootDir, "bin", name)))
      .filter(Boolean),
  );
  const isWrapper = (candidate) => {
    const real = canonical(candidate);
    return real !== null && wrappers.has(real);
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
    `Claude Code executable not found outside ${rootDir}/bin. ` +
      "Install Claude Code or set CLAUDE_CODE_BIN.",
  );
}

export function claudeVersion(bin = resolveClaudeBin()) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
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

async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function waitForHealth(port, { timeoutMs, isAlive }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) return null;
    const health = await probeHealth(port);
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
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
    { cwd: rootDir },
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

export async function startBridge({
  model,
  logPath,
  rootDir = ROOT_DIR,
  env = process.env,
  logLevel = "error",
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
}) {
  if (!model) throw new BridgeStartupError("startBridge requires a model.");

  const port = await pickFreePort();
  const token = randomBytes(24).toString("hex");
  const frontendModel = frontendModelFor(model, { rootDir });

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [path.join(rootDir, "src", "server.mjs")], {
    cwd: rootDir,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BRIDGE_API_KEY: token,
      BRIDGE_INSTANCE_ID: `verify-${model}-${port}`,
      GHCP_MODEL: model,
      LOG_LEVEL: logLevel,
    },
  });

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const health = await waitForHealth(port, {
    timeoutMs: healthTimeoutMs,
    isAlive: () => exited === null,
  });

  if (!health) {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.closeSync(logFd); } catch {}
    throw new BridgeStartupError(
      exited
        ? `Bridge for ${model} exited (code=${exited.code} signal=${exited.signal}) before becoming healthy.`
        : `Bridge for ${model} was not healthy within ${healthTimeoutMs}ms.`,
      { model, log: readTail(logPath, 2000) },
    );
  }

  return {
    model,
    frontendModel,
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath,
    health,
    pid: child.pid,
    isAlive: () => exited === null,
    async stop() {
      if (exited) {
        try { fs.closeSync(logFd); } catch {}
        return exited;
      }
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
      const result = await once(child, "exit").catch(() => [null, null]);
      clearTimeout(timer);
      try { fs.closeSync(logFd); } catch {}
      return { code: result?.[0] ?? null, signal: result?.[1] ?? null };
    },
  };
}

/**
 * Confirm the bridge really serves the requested model before anything runs.
 *
 * `?all=true` is required: CLAUDE_CODE_BUILT_IN_MODELS are filtered out of the
 * default discovery response (src/model-map.mjs), so several of the primary
 * models are invisible without it.
 */
export async function assertModelServed(bridge) {
  const res = await fetch(`${bridge.baseUrl}/v1/models?all=true`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  if (!res.ok) {
    throw new BridgeStartupError(
      `Model discovery failed for ${bridge.model}: HTTP ${res.status}`,
      { model: bridge.model },
    );
  }
  const ids = ((await res.json())?.data ?? []).map((entry) => entry.id);

  // Discovery advertises Copilot model ids; `frontendModel` is the alias
  // Claude Code is launched with. The two differ wherever a dot is illegal in
  // the frontend id -- `claude-haiku-4.5` is advertised, `claude-haiku-4-5` is
  // what Claude Code is told to use -- so insisting on the alias alone marked
  // a perfectly healthy bridge as dead for a whole model.
  const accepted = [bridge.model, bridge.frontendModel].filter(Boolean);
  if (!accepted.some((id) => ids.includes(id))) {
    throw new BridgeStartupError(
      `Bridge does not serve ${accepted.join(" or ")} (advertises ${ids.length} models).`,
      { model: bridge.model },
    );
  }
  return ids;
}

/**
 * Write launch settings through the production writer, so each slot sees
 * exactly what bin/claude-ghcp would have written.
 */
export function writeLaunchSettings({ bridge, settingsPath, rootDir = ROOT_DIR, env = process.env }) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const result = spawnSyncCapture(
    process.execPath,
    [
      path.join(rootDir, "src", "write-launch-settings.mjs"),
      settingsPath,
      bridge.baseUrl,
      bridge.token,
      bridge.frontendModel,
    ],
    { cwd: rootDir, env },
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

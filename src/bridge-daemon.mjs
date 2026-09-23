import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

import { isEntryPoint } from "./entry-point.mjs";
import { leaseFileName } from "./retirement.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "server.mjs");
const implementationFiles = [
  "package.json",
  "package-lock.json",
  ...fs
    .readdirSync(path.join(rootDir, "src"))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => `src/${name}`),
];

export function daemonPaths(env = process.env) {
  const base =
    env.GHCP_DAEMON_DIR ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "claude-code-ghcp-sdk")
      : path.join(
          env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
          "claude-code-ghcp-sdk",
        ));
  return {
    base,
    lock: path.join(base, "bridge.lock"),
    log: path.join(base, "bridge.log"),
    leases: path.join(base, "leases"),
    registry: path.join(base, "bridge.json"),
    retired: path.join(base, "retired"),
    settings: path.join(base, "settings"),
  };
}

function ensureBase(paths) {
  fs.mkdirSync(paths.base, { mode: 0o700, recursive: true });
  fs.chmodSync(paths.base, 0o700);
}

// A launch's settings file holds a live bridge token, so it lives in the
// daemon-owned 0700 tree rather than the caller's temp dir: a backgrounded
// Claude Code job is respawned from --settings long after the launcher exits.
// Nothing knows when a given job is finally done, so reap by age instead --
// generously, because deleting a file a live job still needs reinstates the
// very crash this directory exists to prevent.
const SETTINGS_TTL_MS = 24 * 60 * 60 * 1000;

function reapSettings(paths, now) {
  let entries;
  try {
    entries = fs.readdirSync(paths.settings);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(paths.settings, entry);
    try {
      if (now - fs.statSync(file).mtimeMs > SETTINGS_TTL_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  }
}

export function allocateSettingsPath(env = process.env) {
  const paths = daemonPaths(env);
  ensureBase(paths);
  fs.mkdirSync(paths.settings, { mode: 0o700, recursive: true });
  fs.chmodSync(paths.settings, 0o700);
  reapSettings(paths, Date.now());
  return path.join(paths.settings, `${randomBytes(12).toString("hex")}.json`);
}

function clearSettings(paths) {
  fs.rmSync(paths.settings, { force: true, recursive: true });
}

export function daemonConfigFingerprint(env, requestedPort) {
  const configuration = Object.fromEntries(
    Object.keys(env)
      .filter((name) =>
        /^(COPILOT_|CLEANUP_TIMEOUT_MS$|GH_CONFIG_DIR$|GH_TOKEN$|GITHUB_TOKEN$|HOME$|HTTPS?_PROXY$|NO_PROXY$|LOG_LEVEL$|MAX_|PENDING_TOOL_WAIT_MS$|RETIRED_IDLE_MS$|SESSION_OPERATION_TIMEOUT_MS$|STATE_IDLE_TTL_MS$|TURN_IDLE_TIMEOUT_MS$|TURN_MAX_DURATION_MS$)/.test(
          name,
        ),
      )
      .sort()
      .map((name) => [name, env[name] || ""]),
  );
  const implementation = createHash("sha256");
  implementation.update(rootDir);
  for (const relativePath of implementationFiles) {
    implementation.update(relativePath);
    implementation.update(fs.readFileSync(path.join(rootDir, relativePath)));
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        configuration,
        implementation: implementation.digest("hex"),
        requestedPort: requestedPort || null,
      }),
    )
    .digest("hex");
}

export function readDaemonRegistry(paths = daemonPaths()) {
  try {
    const registry = JSON.parse(fs.readFileSync(paths.registry, "utf8"));
    return registry &&
      Number.isSafeInteger(registry.pid) &&
      Number.isSafeInteger(registry.port) &&
      typeof registry.configFingerprint === "string" &&
      typeof registry.instanceId === "string" &&
      typeof registry.token === "string"
      ? registry
      : null;
  } catch {
    return null;
  }
}

export function writeDaemonRegistry(paths, registry) {
  const temporary = `${paths.registry}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, paths.registry);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(registry) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${registry.port}/health`,
      { signal: AbortSignal.timeout(1_000) },
    );
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function modelAvailable(registry, model) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${registry.port}/v1/models?all=true`,
      {
        headers: { "x-api-key": registry.token },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) return false;
    const body = await response.json();
    return body.data?.some(
      (candidate) =>
        candidate.id === model || candidate.backend_id === model,
    );
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function removeRegistry(paths) {
  fs.rmSync(paths.registry, { force: true });
}

async function stopRegistry(paths, registry, { ownedPid } = {}) {
  if (!registry) {
    removeRegistry(paths);
    return false;
  }
  const currentHealth = registry ? await health(registry) : null;
  const verified =
    registry &&
    (ownedPid === registry.pid ||
      (currentHealth?.instanceId &&
        currentHealth.instanceId === registry.instanceId));
  if (pidAlive(registry.pid) && !verified) {
    throw new Error(
      "Persistent bridge PID is live but its instance could not be verified; registry was preserved.",
    );
  }
  if (verified && pidAlive(registry.pid)) {
    try {
      process.kill(registry.pid, "SIGTERM");
    } catch {}
    for (let attempt = 0; attempt < 50 && pidAlive(registry.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (pidAlive(registry.pid)) {
      try {
        process.kill(registry.pid, "SIGKILL");
      } catch {}
      for (
        let attempt = 0;
        attempt < 20 && pidAlive(registry.pid);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (pidAlive(registry.pid)) {
      throw new Error(
        "Persistent bridge did not stop; registry was preserved for retry.",
      );
    }
  }
  removeRegistry(paths);
  return true;
}

function recordsIn(directory) {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function liveRetired(paths) {
  return recordsIn(paths.retired)
    .map((file) => ({ file, record: readDaemonRegistry({ registry: file }) }))
    .filter(({ record }) => record && pidAlive(record.pid));
}

function pruneRetired(paths) {
  const live = new Set(liveRetired(paths).map(({ file }) => file));
  for (const file of recordsIn(paths.retired)) {
    if (!live.has(file)) fs.rmSync(file, { force: true });
  }
}

// A lease names the launcher holding it, so one whose PID is gone counts for
// nothing. An unparseable one is only removed once it is old enough that it
// cannot be a launcher still writing it.
function pruneLeases(paths, now) {
  let entries;
  try {
    entries = fs.readdirSync(paths.leases);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(paths.leases, entry);
    try {
      const pid = Number(fs.readFileSync(file, "utf8").trim());
      const dead = Number.isSafeInteger(pid) && pid > 0
        ? !pidAlive(pid)
        : now - fs.statSync(file).mtimeMs > 60_000;
      if (dead) fs.rmSync(file, { force: true });
    } catch {}
  }
}

// Every interactive launch shares this bridge, so replacing it must not cut
// off the sessions still pointed at it: see src/retirement.mjs. Only a verified
// bridge that advertises retirement gets SIGUSR2 -- an older one would take the
// signal's default action and die mid-request -- and never when the new bridge
// needs its port. The record is what lets claude-ghcp-stop end it later.
function retireRegistry(paths, registry, currentHealth, requestedPort) {
  if (
    !registry ||
    !pidAlive(registry.pid) ||
    !currentHealth?.instanceId ||
    currentHealth.instanceId !== registry.instanceId ||
    currentHealth.capabilities?.retirement !== true ||
    (requestedPort && requestedPort === registry.port)
  ) {
    return false;
  }
  fs.mkdirSync(paths.retired, { mode: 0o700, recursive: true });
  fs.chmodSync(paths.retired, 0o700);
  const record = path.join(paths.retired, `${registry.instanceId}.json`);
  writeDaemonRegistry(
    { registry: record },
    { ...registry, retiredAt: new Date().toISOString() },
  );
  try {
    process.kill(registry.pid, "SIGUSR2");
  } catch {
    fs.rmSync(record, { force: true });
    return false;
  }
  removeRegistry(paths);
  return true;
}

// A retired bridge keeps its port while it drains, so a replacement pinned to
// that port has to end it first.
async function stopRetiredOnPort(paths, port) {
  for (const { file, record } of liveRetired(paths)) {
    if (record.port === port) await stopRegistry({ registry: file }, record);
  }
}

// What one launch needs: the bridge itself, a settings file of its own, and a
// lease that keeps this bridge serving it should the bridge later be retired.
function launchGrant(paths, env, registry) {
  fs.mkdirSync(paths.leases, { mode: 0o700, recursive: true });
  fs.chmodSync(paths.leases, 0o700);
  return {
    ...registry,
    leasePath: path.join(
      paths.leases,
      leaseFileName(registry.instanceId, randomBytes(8).toString("hex")),
    ),
    logPath: paths.log,
    settingsPath: allocateSettingsPath(env),
  };
}

async function acquireLock(paths) {
  return lockfile.lock(paths.base, {
    lockfilePath: paths.lock,
    realpath: false,
    retries: {
      factor: 1,
      maxTimeout: 1_000,
      minTimeout: 1_000,
      retries: 180,
    },
    stale: 180_000,
    update: 10_000,
  });
}

export async function ensureDaemon(
  model,
  { env = process.env, port: requestedPort } = {},
) {
  const paths = daemonPaths(env);
  const configFingerprint = daemonConfigFingerprint(env, requestedPort);
  ensureBase(paths);
  const release = await acquireLock(paths);
  try {
    let registry = readDaemonRegistry(paths);
    const currentHealth = registry ? await health(registry) : null;
    if (
      registry &&
      pidAlive(registry.pid) &&
      registry.configFingerprint === configFingerprint &&
      currentHealth?.instanceId === registry.instanceId
    ) {
      if (!(await modelAvailable(registry, model))) {
        throw new Error(`GitHub Copilot model is unavailable: ${model}`);
      }
      return launchGrant(paths, env, registry);
    }
    pruneRetired(paths);
    pruneLeases(paths, Date.now());
    // A retired bridge's sessions still hold settings files naming it, so they
    // stay until the TTL reaper. Only a bridge that is really gone takes them.
    if (!retireRegistry(paths, registry, currentHealth, requestedPort)) {
      await stopRegistry(paths, registry);
      clearSettings(paths);
    }
    if (requestedPort) await stopRetiredOnPort(paths, requestedPort);

    const port = requestedPort || (await freePort());
    const token = randomBytes(24).toString("hex");
    const instanceId = randomBytes(16).toString("hex");
    const logFd = fs.openSync(paths.log, "a", 0o600);
    const child = spawn(process.execPath, [serverPath], {
      // Every interactive launch now shares this bridge, so it must not keep
      // whichever project happened to start it: that directory can be deleted
      // under it, and the runtime starts that project's MCP servers for every
      // other project's session. The system prompt is replaced wholesale, so
      // nothing else reads the working directory.
      cwd: paths.base,
      detached: true,
      env: {
        ...env,
        BRIDGE_API_KEY: token,
        BRIDGE_INSTANCE_ID: instanceId,
        BRIDGE_LEASE_DIR: paths.leases,
        GHCP_MODEL: model,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    registry = {
      createdAt: new Date().toISOString(),
      configFingerprint,
      instanceId,
      model,
      pid: child.pid,
      port,
      token,
      version: 1,
    };
    writeDaemonRegistry(paths, registry);

    // Same cold boot as bin/claude-ghcp's ephemeral branch -- three upstream
    // Copilot round-trips before server.listen -- and the same 60s ceiling, but
    // written as a deadline because an attempt count was never a wall-clock
    // bound here: health() spends up to 1s per attempt (AbortSignal.timeout)
    // on top of the 250ms sleep, so the old `attempt < 120` was 30s against a
    // refused port and up to 150s against a bridge that binds the port but
    // never answers. This is the loop the harness actually exercises -- every
    // launch but -p sets PERSISTENT_BRIDGE=1, so the launcher call that starts
    // a daemon comes through here rather than through the launcher's own wait.
    //
    // That caller caps the whole launcher at 120s (spawnSync timeout 120_000,
    // scripts/verify/drivers.mjs). 60s plus at most one overshooting attempt
    // (1s probe + 250ms sleep) is 61.25s, which leaves ~58s of the cap for the
    // 2s modelAvailable() check below, write-launch-settings, and Claude Code's
    // own startup-and-background.
    const healthDeadline = Date.now() + 60_000;
    while (Date.now() < healthDeadline) {
      if (!pidAlive(child.pid)) {
        removeRegistry(paths);
        throw new Error(`Persistent bridge exited; inspect ${paths.log}.`);
      }
      if (await health(registry)) {
        if (!(await modelAvailable(registry, model))) {
          await stopRegistry(paths, registry, { ownedPid: child.pid });
          throw new Error(`GitHub Copilot model is unavailable: ${model}`);
        }
        return launchGrant(paths, env, registry);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await stopRegistry(paths, registry, { ownedPid: child.pid });
    throw new Error(`Timed out waiting for persistent bridge; inspect ${paths.log}.`);
  } finally {
    release();
  }
}

export async function stopDaemon(env = process.env) {
  const paths = daemonPaths(env);
  ensureBase(paths);
  const release = await acquireLock(paths);
  try {
    const registry = readDaemonRegistry(paths);
    const stopped = await stopRegistry(paths, registry);
    // A retired bridge that stays busy never exits by itself, so it ends here
    // with the rest. One whose PID is live but unverified keeps its record.
    for (const file of recordsIn(paths.retired)) {
      const record = readDaemonRegistry({ registry: file });
      await stopRegistry({ registry: file }, record).catch(() => {});
    }
    fs.rmSync(paths.leases, { force: true, recursive: true });
    fs.rmSync(paths.log, { force: true });
    clearSettings(paths);
    return stopped;
  } finally {
    release();
  }
}

async function main() {
  const [command = "status", model, portValue] = process.argv.slice(2);
  if (command === "ensure") {
    if (!model) throw new Error("Usage: bridge-daemon.mjs ensure <model>");
    const port = portValue ? Number(portValue) : undefined;
    if (
      port !== undefined &&
      (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new Error("Persistent bridge port must be between 1 and 65535.");
    }
    const registry = await ensureDaemon(model, { port });
    console.log(JSON.stringify(registry));
    return;
  }
  if (command === "stop") {
    console.log(JSON.stringify({ stopped: await stopDaemon() }));
    return;
  }
  if (command === "status") {
    const paths = daemonPaths();
    const registry = readDaemonRegistry(paths);
    const running = Boolean(
      registry && pidAlive(registry.pid) && (await health(registry)),
    );
    console.log(
      JSON.stringify({
        model: running ? registry.model : null,
        pid: running ? registry.pid : null,
        port: running ? registry.port : null,
        // Replaced bridges still serving the sessions that started on them.
        retired: liveRetired(paths).length,
        running,
      }),
    );
    return;
  }
  throw new Error("Usage: bridge-daemon.mjs <ensure MODEL|status|stop>");
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

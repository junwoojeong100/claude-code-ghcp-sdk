import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "server.mjs");

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
    registry: path.join(base, "bridge.json"),
  };
}

function ensureBase(paths) {
  fs.mkdirSync(paths.base, { mode: 0o700, recursive: true });
  fs.chmodSync(paths.base, 0o700);
}

function daemonConfigFingerprint(env, requestedPort) {
  const configuration = Object.fromEntries(
    [
      "COPILOT_HOME",
      "GH_CONFIG_DIR",
      "HOME",
      "LOG_LEVEL",
      "MAX_BODY_BYTES",
      "MAX_REPLAY_BYTES",
      "MAX_STATES",
      "MAX_TOOL_RESULTS",
      "PENDING_TOOL_WAIT_MS",
      "STATE_IDLE_TTL_MS",
    ].map((name) => [name, env[name] || ""]),
  );
  return createHash("sha256")
    .update(JSON.stringify({ configuration, requestedPort: requestedPort || null }))
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
  const currentHealth = registry ? await health(registry) : null;
  const verified =
    registry &&
    (ownedPid === registry.pid ||
      (currentHealth?.instanceId &&
        currentHealth.instanceId === registry.instanceId));
  if (verified && pidAlive(registry.pid)) {
    try {
      process.kill(registry.pid, "SIGTERM");
    } catch {}
    for (let attempt = 0; attempt < 50 && pidAlive(registry.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  removeRegistry(paths);
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
      return registry;
    }
    await stopRegistry(paths, registry);

    const port = requestedPort || (await freePort());
    const token = randomBytes(24).toString("hex");
    const instanceId = randomBytes(16).toString("hex");
    const logFd = fs.openSync(paths.log, "a", 0o600);
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      env: {
        ...env,
        BRIDGE_API_KEY: token,
        BRIDGE_INSTANCE_ID: instanceId,
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

    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (!pidAlive(child.pid)) {
        removeRegistry(paths);
        throw new Error(`Persistent bridge exited; inspect ${paths.log}.`);
      }
      if (await health(registry)) {
        if (!(await modelAvailable(registry, model))) {
          await stopRegistry(paths, registry, { ownedPid: child.pid });
          throw new Error(`GitHub Copilot model is unavailable: ${model}`);
        }
        return registry;
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
    await stopRegistry(paths, registry);
    fs.rmSync(paths.log, { force: true });
    return Boolean(registry);
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
        running,
      }),
    );
    return;
  }
  throw new Error("Usage: bridge-daemon.mjs <ensure MODEL|status|stop>");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

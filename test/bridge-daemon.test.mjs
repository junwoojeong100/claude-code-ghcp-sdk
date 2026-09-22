import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import test from "node:test";

import {
  allocateSettingsPath,
  daemonConfigFingerprint,
  daemonPaths,
  ensureDaemon,
  readDaemonRegistry,
  stopDaemon,
  writeDaemonRegistry,
} from "../src/bridge-daemon.mjs";
import { waitForHealth } from "../scripts/verify/bridge.mjs";

test("writes persistent bridge registry with private permissions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const paths = daemonPaths({ GHCP_DAEMON_DIR: directory });
  const registry = {
    configFingerprint: "config-1",
    instanceId: "instance-1",
    model: "claude-sonnet-5",
    pid: 999_999,
    port: 4142,
    token: "test-only",
  };

  try {
    writeDaemonRegistry(paths, registry);
    assert.deepEqual(readDaemonRegistry(paths), registry);
    assert.equal(statSync(paths.registry).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(paths.registry, "utf8"), /\n\n/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function unverifiedDaemonPort(t) {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server.address().port;
}

test("stopping a stale daemon removes its registry", async (t) => {
  const port = await unverifiedDaemonPort(t);
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };
  const paths = daemonPaths(env);

  try {
    writeDaemonRegistry(paths, {
      configFingerprint: "config-1",
      instanceId: "instance-1",
      model: "claude-sonnet-5",
      pid: 999_999,
      port,
      token: "test-only",
    });

    assert.equal(await stopDaemon(env), true);
    assert.equal(readDaemonRegistry(paths), null);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("does not terminate an unverified process from a stale registry", async (t) => {
  const port = await unverifiedDaemonPort(t);
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };
  const paths = daemonPaths(env);
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);

  try {
    writeDaemonRegistry(paths, {
      configFingerprint: "config-1",
      instanceId: "not-the-bridge",
      model: "claude-sonnet-5",
      pid: child.pid,
      port,
      token: "test-only",
    });
    await assert.rejects(
      stopDaemon(env),
      /instance could not be verified/,
    );
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.notEqual(readDaemonRegistry(paths), null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    rmSync(directory, { force: true, recursive: true });
  }
});

test("allocates a private settings path per launch", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };
  const paths = daemonPaths(env);

  try {
    const first = allocateSettingsPath(env);
    const second = allocateSettingsPath(env);

    assert.equal(path.dirname(first), paths.settings);
    assert.equal(path.dirname(second), paths.settings);
    assert.equal(statSync(paths.settings).mode & 0o777, 0o700);
    // Two concurrent background launches must not share one settings file.
    assert.notEqual(first, second);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("stopping the daemon removes the settings directory", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };
  const paths = daemonPaths(env);

  try {
    writeFileSync(allocateSettingsPath(env), "{}\n", { mode: 0o600 });

    await stopDaemon(env);
    assert.equal(existsSync(paths.settings), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// ensureDaemon's reuse guard is a conjunction, so a stub that fails any of its
// other terms hides whatever the test meant to exercise. This one is live and
// answers /health with the instanceId the registry claims, which leaves the
// caller free to choose exactly one condition to break. It has to be a
// separate process on two counts: ensureDaemon probes /health with fetch while
// this process is inside the call, and its restart path SIGTERMs the registry
// PID -- naming our own PID there would kill the test runner.
async function verifiedDaemonStub(t, instanceId, model) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const http = require("node:http");',
        "const [instanceId, model] = process.argv.slice(1);",
        "const server = http.createServer((request, response) => {",
        '  const body = request.url.startsWith("/health")',
        "    ? { instanceId, ok: true }",
        "    : { data: [{ backend_id: model, id: model }] };",
        '  response.writeHead(200, { "content-type": "application/json" });',
        "  response.end(JSON.stringify(body));",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        "  console.log(server.address().port);",
        "});",
      ].join("\n"),
      instanceId,
      model,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      resolve({ pid: child.pid, port: Number(chunk.toString()) });
    });
  });
}

test("daemon reuse includes the SDK session-operation timeout in its fingerprint", () => {
  assert.notEqual(
    daemonConfigFingerprint({ SESSION_OPERATION_TIMEOUT_MS: "60000" }),
    daemonConfigFingerprint({ SESSION_OPERATION_TIMEOUT_MS: "20000" }),
  );
});

test("restarting on a changed config fingerprint clears settings files", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  // An unparseable MAX_ value makes the replacement bridge exit while it reads
  // its environment, so the restart path runs without a live upstream session.
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const instanceId = "instance-1";
  const model = "claude-sonnet-5";
  // Registering the stub's own PID and instanceId satisfies the two reuse
  // conditions this test is not about, so the stale fingerprint below is the
  // only thing that can still send ensureDaemon down the restart path. Seed a
  // matching fingerprint instead and the reuse path returns normally, which
  // turns the assert.rejects below red -- that is the check that this test
  // still guards the fingerprint comparison in src/bridge-daemon.mjs.
  const { pid, port } = await verifiedDaemonStub(t, instanceId, model);
  const otherFingerprint = daemonConfigFingerprint({ ...env, MAX_STATES: "8" });

  try {
    assert.notEqual(daemonConfigFingerprint(env), otherFingerprint);
    writeFileSync(allocateSettingsPath(env), "{}\n", { mode: 0o600 });
    writeDaemonRegistry(paths, {
      configFingerprint: otherFingerprint,
      instanceId,
      model,
      pid,
      port,
      token: "test-only",
    });

    await assert.rejects(
      ensureDaemon(model, { env }),
      /Persistent bridge exited/,
    );
    // The old bridge's token died with it, so its settings files are unusable.
    assert.equal(existsSync(paths.settings), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("reaps only settings files older than the launch TTL", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };

  try {
    const stale = allocateSettingsPath(env);
    const live = allocateSettingsPath(env);
    writeFileSync(stale, "{}\n", { mode: 0o600 });
    writeFileSync(live, "{}\n", { mode: 0o600 });
    // Brackets the 24h SETTINGS_TTL_MS in src/bridge-daemon.mjs from both
    // sides. Backdating the mtime keeps this instant; a sleep cannot reach it.
    const seconds = Date.now() / 1000;
    const hour = 60 * 60;
    utimesSync(stale, seconds - 25 * hour, seconds - 25 * hour);
    utimesSync(live, seconds - 23 * hour, seconds - 23 * hour);

    allocateSettingsPath(env);

    assert.equal(existsSync(stale), false);
    // Claude Code respawns a backgrounded job from its settings file hours
    // after the launcher exited. Reaping one still inside the TTL reinstates
    // the "Settings file not found" crash this directory exists to prevent.
    assert.equal(existsSync(live), true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// waitForHealth belongs to the verification harness (scripts/verify/bridge.mjs)
// rather than the daemon, but it polls a bridge's /health exactly as the daemon
// does, and the failure it has to survive is this file's subject: a bridge that
// binds its port during a slow cold boot and answers nothing until it is done.
async function silentBridgePort(t) {
  const sockets = new Set();
  const server = createSocketServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return server.address().port;
}

test("health polling gives up on a bridge that binds its port but never answers", async (t) => {
  const port = await silentBridgePort(t);
  const budgetMs = 1_000;
  // waitForHealth only compares the clock between probes, never during one, so
  // its budget is a ceiling only for as long as a single probe is bounded. With
  // the probe's AbortSignal this settles at roughly one abort past the budget;
  // with a bare fetch the first probe waits on undici's header timeout instead
  // and this tripwire is the only thing that would ever end the test.
  const tripwireMs = 8_000;
  const started = Date.now();

  const outcome = await Promise.race([
    waitForHealth(port, { timeoutMs: budgetMs }).then(() => "gave up"),
    new Promise((resolve) => {
      setTimeout(() => resolve("still probing"), tripwireMs).unref();
    }),
  ]);

  assert.equal(
    outcome,
    "gave up",
    `waitForHealth was still probing ${Date.now() - started}ms into a ${budgetMs}ms budget: its probe carries no deadline of its own, so the budget is a floor rather than a ceiling`,
  );
});

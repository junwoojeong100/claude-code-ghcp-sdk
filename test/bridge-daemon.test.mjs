import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
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

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");

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

// A live PID whose /health does not answer is only signalled once ps shows it
// is this checkout's bridge. After a reboot the registry survives and its PID
// can belong to anything, so a PID running something else is a stale registry.
function liveChild(t, args, options) {
  const child = spawn(process.execPath, args, options);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  t.after(async () => {
    if (!exited) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  return { pid: child.pid, exited: () => exited };
}

function seedLaunchFiles(env, paths, instanceId) {
  writeFileSync(allocateSettingsPath(env), "{}\n", { mode: 0o600 });
  mkdirSync(paths.leases, { recursive: true });
  writeFileSync(path.join(paths.leases, `${instanceId}.a.pid`), `${process.pid}\n`);
  writeFileSync(paths.log, "old bridge output\n");
}

test("a stale registry naming a reused PID is dropped without signalling it", async (t) => {
  const port = await unverifiedDaemonPort(t);
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  // Another project's src/server.mjs is not a bridge either: no checkout's
  // bin/resolve-claude.sh sits beside it.
  const otherApp = path.join(directory, "other-app", "src", "server.mjs");
  mkdirSync(path.dirname(otherApp), { recursive: true });
  writeFileSync(otherApp, "setInterval(() => {}, 1000);\n");

  for (const args of [["-e", "setInterval(() => {}, 1000)"], [otherApp]]) {
    const child = liveChild(t, args);
    const registry = {
      configFingerprint: "config-1",
      instanceId: "not-the-bridge",
      model: "claude-sonnet-5",
      pid: child.pid,
      port,
      token: "test-only",
    };
    await new Promise((resolve) => setTimeout(resolve, 200));

    writeDaemonRegistry(paths, registry);
    seedLaunchFiles(env, paths, registry.instanceId);
    assert.equal(await stopDaemon(env), true, args.join(" "));
    assert.equal(child.exited(), false);
    assert.equal(readDaemonRegistry(paths), null);
    for (const leftover of [paths.settings, paths.leases, paths.log]) {
      assert.equal(existsSync(leftover), false, leftover);
    }

    // ensure takes the same view: it replaces the registry instead of refusing
    // every launch until the unrelated process exits. The replacement dies on
    // MAX_STATES before any Copilot call.
    writeDaemonRegistry(paths, registry);
    await assert.rejects(ensureDaemon("claude-sonnet-5", { env }), /Persistent bridge exited/);
    assert.equal(child.exited(), false);
  }
});

// Command line exactly as ensureDaemon spawns the bridge; the preload blocks
// before src/server.mjs runs, so it never answers /health. MAX_STATES stops
// src/server.mjs before any Copilot call should the preload ever not load.
// The other variant is a second checkout's bridge sharing the daemon directory.
function unresponsiveBridge(t, directory, { otherCheckout = false } = {}) {
  const hang = path.join(directory, "hang.cjs");
  writeFileSync(hang, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n");
  if (otherCheckout) {
    const checkout = path.join(directory, "other-checkout");
    mkdirSync(path.join(checkout, "bin"), { recursive: true });
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(path.join(checkout, "bin", "resolve-claude.sh"), "");
    writeFileSync(path.join(checkout, "src", "server.mjs"), readFileSync(hang));
    return liveChild(t, [path.join(checkout, "src", "server.mjs")], { stdio: "ignore" });
  }
  return liveChild(t, [serverPath], {
    env: { ...process.env, MAX_STATES: "not-a-number", NODE_OPTIONS: `--require ${JSON.stringify(hang)}` },
    stdio: "ignore",
  });
}

for (const otherCheckout of [false, true]) {
  const label = otherCheckout ? " from another checkout" : "";
  test(`ensure refuses to start a second bridge beside an unresponsive one${label}`, async (t) => {
    const port = await unverifiedDaemonPort(t);
    const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
    const paths = daemonPaths(env);
    const bridge = unresponsiveBridge(t, directory, { otherCheckout });
    const registry = {
      configFingerprint: "config-1",
      createdAt: new Date().toISOString(),
      instanceId: "instance-wedged",
      model: "claude-sonnet-5",
      pid: bridge.pid,
      port,
      token: "test-only",
    };
    writeDaemonRegistry(paths, registry);
    // ps must see the final command line, not node still execing.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const error = await ensureDaemon("claude-sonnet-5", { env }).then(
      () => assert.fail("ensureDaemon started beside an unresponsive bridge"),
      (rejection) => rejection,
    );
    for (const detail of [`PID ${bridge.pid}`, `port ${port}`, paths.registry, "claude-ghcp-stop"]) {
      assert.ok(error.message.includes(detail), `${detail} missing from: ${error.message}`);
    }
    assert.equal(bridge.exited(), false);
    assert.deepEqual(readDaemonRegistry(paths), registry);

    // claude-ghcp-stop is the recovery step the error names, so it must work.
    assert.equal(await stopDaemon(env), true);
    assert.equal(bridge.exited(), true);
    assert.equal(readDaemonRegistry(paths), null);
  });
}

// After a reboot or a crash the registry survives, and its PID can be reused by
// another bridge-shaped process: a claude-ghcp -p private bridge, the live
// verifier's, or another daemon directory's. It started after the registry was
// written, so it is not the registered bridge and is never signalled. Only
// macOS lstart is trusted for this; see the wall-clock test below.
for (const otherCheckout of [false, true]) {
  const label = otherCheckout ? " from another checkout" : "";
  test(`a stale registry whose PID was reused by a bridge${label} is dropped without signalling it`, { skip: process.platform !== "darwin" }, async (t) => {
    const port = await unverifiedDaemonPort(t);
    const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
    const paths = daemonPaths(env);
    const bridge = unresponsiveBridge(t, directory, { otherCheckout });
    const registry = {
      configFingerprint: "config-1",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      instanceId: "instance-dead",
      model: "claude-sonnet-5",
      pid: bridge.pid,
      port,
      token: "test-only",
    };
    await new Promise((resolve) => setTimeout(resolve, 300));

    writeDaemonRegistry(paths, registry);
    assert.equal(await stopDaemon(env), true);
    assert.equal(bridge.exited(), false);
    assert.equal(readDaemonRegistry(paths), null);

    // ensure replaces the registry instead of refusing every launch; the
    // replacement dies on MAX_STATES before any Copilot call.
    writeDaemonRegistry(paths, registry);
    await assert.rejects(ensureDaemon("claude-sonnet-5", { env }), /Persistent bridge exited/);
    assert.equal(bridge.exited(), false);
  });
}

// procps prints lstart as /proc/stat btime plus the start ticks, and btime
// moves with every wall-clock step, so after a forward step the registered
// bridge shows a start later than createdAt. A fake ps shifts lstart by an
// hour; off macOS the bridge must still be refused beside and then stopped.
// The darwin run proves the shift is seen: there it reads as a reused PID.
test("a registered bridge whose lstart moved with the wall clock is still refused and stopped off macOS", async (t) => {
  const port = await unverifiedDaemonPort(t);
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const fakeBin = path.join(directory, "fake-bin");
  mkdirSync(fakeBin);
  const realPs = spawnSync("/bin/sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  assert.ok(path.isAbsolute(realPs), realPs);
  writeFileSync(path.join(fakeBin, "ps"), [
    `#!${process.execPath}`,
    'const { spawnSync } = require("node:child_process");',
    "const args = process.argv.slice(2);",
    `const out = spawnSync(${JSON.stringify(realPs)}, args, { encoding: "utf8", timeout: 5_000 });`,
    'process.stdout.write(out.status === 0 && args.includes("lstart=")',
    '  ? `${new Date(Date.parse(out.stdout.trim()) + 3_600_000).toString()}\\n`',
    "  : out.stdout);",
    "process.exit(out.status ?? 1);",
  ].join("\n"), { mode: 0o755 });
  const script = [
    'Object.defineProperty(process, "platform", { value: process.argv[1] });',
    `const daemon = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(serverPath), "bridge-daemon.mjs")).href)});`,
    "const env = { GHCP_DAEMON_DIR: process.env.GHCP_DAEMON_DIR, MAX_STATES: \"not-a-number\" };",
    "const ensure = process.argv[2] === \"ensure\"",
    '  ? await daemon.ensureDaemon("claude-sonnet-5", { env }).then(() => "started", (error) => error.message)',
    "  : null;",
    "console.log(JSON.stringify({ ensure, stopped: ensure === null ? await daemon.stopDaemon(env) : null }));",
  ].join("\n");
  const run = async (platform, action) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, platform, action], {
      env: { ...process.env, GHCP_DAEMON_DIR: directory, PATH: `${fakeBin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, out);
    return JSON.parse(out);
  };
  const bridge = unresponsiveBridge(t, directory, { otherCheckout: true });
  const registry = {
    configFingerprint: "config-1",
    createdAt: new Date().toISOString(),
    instanceId: "instance-wedged",
    model: "claude-sonnet-5",
    pid: bridge.pid,
    port,
    token: "test-only",
  };
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeDaemonRegistry(paths, registry);
  assert.deepEqual(await run("darwin", "stop"), { ensure: null, stopped: true });
  assert.equal(bridge.exited(), false);
  assert.equal(readDaemonRegistry(paths), null);

  writeDaemonRegistry(paths, registry);
  const { ensure } = await run("linux", "ensure");
  assert.match(ensure, /did not answer \/health.*Run claude-ghcp-stop/);
  assert.deepEqual(readDaemonRegistry(paths), registry);
  assert.deepEqual(await run("linux", "stop"), { ensure: null, stopped: true });
  for (let attempt = 0; attempt < 20 && !bridge.exited(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(bridge.exited(), true);
  assert.equal(readDaemonRegistry(paths), null);
});

// A foreign server on a dead bridge's old port can answer 200 with a body that
// is not JSON; that must read as "no bridge", not reject out of health().
async function htmlResponderPort(t) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>hi</html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return server.address().port;
}

test("a non-JSON /health on the registered port reads as no bridge", async (t) => {
  const port = await htmlResponderPort(t);
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const registry = {
    configFingerprint: "config-1",
    instanceId: "instance-1",
    model: "claude-sonnet-5",
    pid: 999_999,
    port,
    token: "test-only",
  };

  writeDaemonRegistry(paths, registry);
  await assert.rejects(ensureDaemon("claude-sonnet-5", { env }), /Persistent bridge exited/);

  const child = liveChild(t, ["-e", "setInterval(() => {}, 1000)"]);
  writeDaemonRegistry(paths, { ...registry, pid: child.pid });
  assert.equal(await stopDaemon(env), true);
  assert.equal(readDaemonRegistry(paths), null);
  assert.equal(child.exited(), false);
});

// A pinned port another listener already holds: the new child is still booting
// (and will die with EADDRINUSE) while that listener answers /health.
test("startup accepts only the instance it spawned", async (t) => {
  const model = "claude-sonnet-5";
  const server = createServer((request, response) => {
    const body = request.url.startsWith("/health")
      ? { instanceId: "someone-else", ok: true }
      : { data: [{ backend_id: model, id: model }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };

  await assert.rejects(
    ensureDaemon(model, { env, port: server.address().port }),
    /Persistent bridge exited/,
  );
  assert.equal(readDaemonRegistry(daemonPaths(env)), null);
});

test("resolves a relative GHCP_DAEMON_DIR and rejects a literal ~", () => {
  // The bridge runs in this directory, so an unresolved relative value makes it
  // read leases from <dir>/<dir>/leases and ignore every live launcher.
  const paths = daemonPaths({ GHCP_DAEMON_DIR: "relative-daemon-dir" });
  assert.equal(paths.base, path.resolve("relative-daemon-dir"));
  assert.ok(Object.values(paths).every((value) => path.isAbsolute(value)));
  assert.throws(() => daemonPaths({ GHCP_DAEMON_DIR: "~/ghcp" }), /GHCP_DAEMON_DIR .*~/);
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
//
// With `retirement`, it also advertises the capability src/server.mjs does and
// reports each SIGUSR2 on stdout instead of dying from it, the way a real
// bridge that knows how to drain would.
async function verifiedDaemonStub(t, instanceId, model, { retirement = false } = {}) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const http = require("node:http");',
        "const [instanceId, model, retirement] = process.argv.slice(1);",
        'const capabilities = retirement === "1" ? { retirement: true } : {};',
        'if (retirement === "1") process.on("SIGUSR2", () => console.log("SIGUSR2"));',
        "const server = http.createServer((request, response) => {",
        '  const body = request.url.startsWith("/health")',
        "    ? { capabilities, instanceId, ok: true }",
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
      retirement ? "1" : "0",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      const signals = [];
      child.stdout.on("data", (more) => {
        signals.push(...more.toString().split("\n").filter(Boolean));
      });
      resolve({
        pid: child.pid,
        port: Number(chunk.toString()),
        signals,
        exited: () => exited,
      });
    });
  });
}

test("daemon reuse includes the SDK session-operation timeout in its fingerprint", () => {
  assert.notEqual(
    daemonConfigFingerprint({ SESSION_OPERATION_TIMEOUT_MS: "60000" }),
    daemonConfigFingerprint({ SESSION_OPERATION_TIMEOUT_MS: "20000" }),
  );
});

test("daemon reuse includes both turn deadline settings", () => {
  for (const name of ["TURN_IDLE_TIMEOUT_MS", "TURN_MAX_DURATION_MS", "RETIRED_IDLE_MS"]) {
    assert.notEqual(
      daemonConfigFingerprint({ [name]: "300000" }),
      daemonConfigFingerprint({ [name]: "600000" }),
    );
  }
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

// Every interactive launch shares the persistent bridge, so the one being
// replaced may still be serving open sessions whose settings files name its
// port and token. It is retired rather than stopped: see src/retirement.mjs.
test("replacing a bridge that can drain retires it instead of stopping it", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  // As above, the replacement dies reading MAX_STATES, before any Copilot call.
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const instanceId = "instance-retiring";
  const model = "claude-sonnet-5";
  const stub = await verifiedDaemonStub(t, instanceId, model, { retirement: true });
  const openSession = allocateSettingsPath(env);
  writeFileSync(openSession, "{}\n", { mode: 0o600 });
  writeDaemonRegistry(paths, {
    configFingerprint: daemonConfigFingerprint({ ...env, MAX_STATES: "8" }),
    instanceId,
    model,
    pid: stub.pid,
    port: stub.port,
    token: "test-only",
  });

  await assert.rejects(ensureDaemon(model, { env }), /Persistent bridge exited/);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(stub.signals, ["SIGUSR2"]);
  assert.equal(stub.exited(), false);
  // The session still pointed at the retired bridge keeps its settings.
  assert.equal(existsSync(openSession), true);
  const record = readDaemonRegistry({
    registry: path.join(paths.retired, `${instanceId}.json`),
  });
  assert.equal(record?.pid, stub.pid);
  assert.equal(readDaemonRegistry(paths), null);

  // A retired bridge that stays busy never exits by itself, so stop ends it.
  await stopDaemon(env);
  assert.equal(stub.exited(), true);
  assert.equal(existsSync(paths.retired) && readdirSync(paths.retired).length, 0);
});

// A retired bridge keeps its port while it drains, so a replacement pinned to
// that same port can only bind it once the old bridge is gone.
test("a replacement pinned to the old bridge's port stops it instead", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const instanceId = "instance-pinned";
  const model = "claude-sonnet-5";
  const stub = await verifiedDaemonStub(t, instanceId, model, { retirement: true });
  writeDaemonRegistry(paths, {
    configFingerprint: daemonConfigFingerprint({ ...env, MAX_STATES: "8" }, stub.port),
    instanceId,
    model,
    pid: stub.pid,
    port: stub.port,
    token: "test-only",
  });

  await assert.rejects(
    ensureDaemon(model, { env, port: stub.port }),
    /Persistent bridge exited/,
  );

  assert.deepEqual(stub.signals, []);
  assert.equal(stub.exited(), true);
  assert.equal(existsSync(path.join(paths.retired, `${instanceId}.json`)), false);
});

// SIGUSR2's default action terminates a Node process, so sending it to a
// bridge from before retirement existed would kill it mid-request.
test("a bridge that does not advertise retirement is stopped as before", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const env = { GHCP_DAEMON_DIR: directory, MAX_STATES: "not-a-number" };
  const paths = daemonPaths(env);
  const instanceId = "instance-legacy";
  const model = "claude-sonnet-5";
  const stub = await verifiedDaemonStub(t, instanceId, model);
  writeDaemonRegistry(paths, {
    configFingerprint: daemonConfigFingerprint({ ...env, MAX_STATES: "8" }),
    instanceId,
    model,
    pid: stub.pid,
    port: stub.port,
    token: "test-only",
  });

  await assert.rejects(ensureDaemon(model, { env }), /Persistent bridge exited/);

  assert.equal(stub.exited(), true);
  assert.equal(existsSync(path.join(paths.retired, `${instanceId}.json`)), false);
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

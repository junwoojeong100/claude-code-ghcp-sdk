import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  daemonPaths,
  readDaemonRegistry,
  stopDaemon,
  writeDaemonRegistry,
} from "../src/bridge-daemon.mjs";

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

test("stopping a stale daemon removes its registry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-daemon-"));
  const env = { GHCP_DAEMON_DIR: directory };
  const paths = daemonPaths(env);

  try {
    writeDaemonRegistry(paths, {
      configFingerprint: "config-1",
      instanceId: "instance-1",
      model: "claude-sonnet-5",
      pid: 999_999,
      port: 4142,
      token: "test-only",
    });

    assert.equal(await stopDaemon(env), true);
    assert.equal(readDaemonRegistry(paths), null);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("does not terminate an unverified process from a stale registry", async () => {
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
      port: 9,
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

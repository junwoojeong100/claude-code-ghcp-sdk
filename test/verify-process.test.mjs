/** Local subprocess tests only: no launcher, daemon, or model is contacted. */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { runProcess } from "../scripts/verify/process.mjs";

const node = (script, options = {}) => runProcess(process.execPath, ["-e", script], { timeoutMs: 5000, ...options });
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), "condition did not become true within 3s");
}
function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-process-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("slow launcher leaves HTTP heartbeats and an independent child responsive", { timeout: 8000 }, async (t) => {
  let heartbeats = 0;
  const server = http.createServer((_req, res) => { heartbeats += 1; res.end("alive"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let launcherFinished = false;
  const launcher = node('setTimeout(() => console.log("launched"), 1000)').then((result) => {
    launcherFinished = true;
    return result;
  });
  const sibling = node('console.log("independent result")');
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), "alive");
  }
  const other = await sibling;
  assert.equal(other.status, 0, other.error?.message);
  assert.equal(other.stdout.trim(), "independent result");
  assert.equal(heartbeats, 3);
  assert.equal(launcherFinished, false, "the launcher blocked peer work until it exited");
  const result = await launcher;
  assert.equal(result.status, 0, result.error?.message);
  assert.equal(result.stdout.trim(), "launched");
  assert.equal(result.completed, true);
});

test("captures exit status, stdout, stderr, cwd and environment without a shell", async (t) => {
  const cwd = temporaryDirectory(t);
  const result = await node('console.log(JSON.stringify([process.cwd(), process.env.TEST_VALUE])); console.error("diagnostic"); process.exitCode = 7', {
    cwd, env: { ...process.env, TEST_VALUE: "value with spaces; no shell" },
  });
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  const [reportedCwd, value] = JSON.parse(result.stdout);
  assert.equal(fs.realpathSync(reportedCwd), fs.realpathSync(cwd));
  assert.equal(value, "value with spaces; no shell");
  assert.equal(result.stderr.trim(), "diagnostic");
});

test("spawn failures and synchronous spawn errors resolve as result data", async (t) => {
  const dir = temporaryDirectory(t);
  const missing = await runProcess(path.join(dir, "does-not-exist"), [], { timeoutMs: 200 });
  assert.equal(missing.error?.code, "ENOENT");
  assert.equal(missing.status, null);
  assert.equal(missing.signal, null);
  assert.equal(missing.stdout, "");
  const invalid = await runProcess("", [], { timeoutMs: 200 });
  assert.ok(invalid.error instanceof Error);
  assert.equal(invalid.status, null);
});

test("a graceful timeout cannot count as completed even with evidence and exit zero", { timeout: 5000 }, async () => {
  const result = await node(`
    process.on("SIGTERM", () => process.exit(0));
    console.log("expected evidence");
    setInterval(() => {}, 1000);
  `, { timeoutMs: 800, killGraceMs: 100 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "expected evidence");
  assert.equal(result.timedOut, true);
  assert.equal(result.completed, false);
});

test("timeout gives SIGTERM a grace period before SIGKILL", { timeout: 8000 }, async (t) => {
  const dir = temporaryDirectory(t);
  const marker = path.join(dir, "term");
  const result = await node(`
    process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "term"));
    console.log("ready");
    setInterval(() => {}, 1000);
  `, { timeoutMs: 800, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(fs.readFileSync(marker, "utf8"), "term");
  assert.ok(result.durationMs >= 890, `grace was skipped: ${result.durationMs}ms`);
  assert.ok(result.durationMs < 3000, `timeout was not bounded: ${result.durationMs}ms`);
  await until(() => !alive(result.pid));
});

test("abort cleans an owned process group even after its leader exits", { timeout: 8000 }, async (t) => {
  const dir = temporaryDirectory(t);
  const ready = path.join(dir, "descendant.pid");
  const controller = new AbortController();
  const grandchildScript = `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const child = node(`
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" }).unref();
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `, { signal: controller.signal, killGraceMs: 100 });
  t.after(() => controller.abort());
  await until(() => fs.existsSync(ready));
  const descendantPid = Number(fs.readFileSync(ready, "utf8"));
  t.after(() => { if (alive(descendantPid)) { try { process.kill(descendantPid, "SIGKILL"); } catch {} } });
  const sibling = node('setTimeout(() => console.log("survived"), 400)');
  controller.abort(new Error("test cancellation"));
  const result = await child;
  assert.equal(result.aborted, true);
  assert.equal(result.error?.code, "ABORT_ERR");
  assert.equal(result.timedOut, false);
  await until(() => !alive(descendantPid));
  const other = await sibling;
  assert.equal(other.status, 0, "cleanup killed an unrelated child");
  assert.equal(other.stdout.trim(), "survived");
});

test("a pre-aborted signal never starts a subprocess", async (t) => {
  const dir = temporaryDirectory(t);
  const marker = path.join(dir, "must-not-exist");
  const signal = AbortSignal.abort("already stopped");
  const result = await node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`, { signal });
  assert.equal(result.error?.code, "ABORT_ERR");
  assert.equal(result.aborted, true);
  assert.equal(result.pid, null);
  assert.equal(fs.existsSync(marker), false);
});

for (const stream of ["stdout", "stderr"]) {
  test(`${stream} overflow stays bounded and terminates the child`, { timeout: 5000 }, async () => {
    const result = await node(`process.${stream}.write("x".repeat(200000)); setInterval(() => {}, 1000)`, {
      maxBuffer: 4096, killGraceMs: 50,
    });
    assert.equal(result.error?.code, "ENOBUFS");
    assert.equal(result[`${stream}Truncated`], true);
    assert.equal(Buffer.byteLength(result[stream]), 4096);
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    assert.ok(Buffer.byteLength(result.stderr) <= 4096);
    await until(() => !alive(result.pid));
  });
}

test("UTF-8 output survives split chunks and stdin is closed", async () => {
  const result = await node(`
    const bytes = Buffer.from("before-✓-after");
    process.stdout.write(bytes.subarray(0, 8));
    setTimeout(() => process.stdout.write(bytes.subarray(8)), 10);
    console.error(require("node:fs").readFileSync(0, "utf8").length);
  `);
  assert.equal(result.stdout, "before-✓-after");
  assert.equal(result.stderr.trim(), "0");
  assert.equal(result.status, 0);
});

test("normal completion removes abort listeners and cancellation timers", async () => {
  const controller = new AbortController();
  const { getEventListeners } = await import("node:events");
  const before = getEventListeners(controller.signal, "abort").length;
  const result = await node('console.log("done")', { signal: controller.signal, timeoutMs: 300, killGraceMs: 50 });
  assert.equal(result.status, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
  controller.abort();
  await delay(350);
  assert.equal(result.aborted, false);
  assert.equal(result.error, undefined);
});

test("invalid resource limits cannot silently disable the timeout or buffer bound", async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { killGraceMs: -1 }, { maxBuffer: 0 }]) {
    const result = await node('throw new Error("must not run")', options);
    assert.ok(result.error instanceof Error);
    assert.equal(result.pid, null);
    assert.equal(result.status, null);
  }
});

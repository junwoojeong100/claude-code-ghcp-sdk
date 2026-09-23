import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  leaseFileName,
  liveLeaseCount,
  Retirement,
} from "../src/retirement.mjs";

function leaseDir(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "ghcp-leases-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("counts only live leases taken on this bridge instance", (t) => {
  const directory = leaseDir(t);
  const live = new Set([101, 202]);
  const pidAlive = (pid) => live.has(pid);
  writeFileSync(path.join(directory, leaseFileName("inst-a", "one")), "101\n");
  writeFileSync(path.join(directory, leaseFileName("inst-a", "two")), "303\n");
  // Another bridge's lease says nothing about this one.
  writeFileSync(path.join(directory, leaseFileName("inst-b", "one")), "202\n");
  // A lease the launcher never finished writing names no PID at all.
  writeFileSync(path.join(directory, leaseFileName("inst-a", "three")), "");
  writeFileSync(path.join(directory, "inst-a.notes.txt"), "101\n");

  assert.equal(liveLeaseCount(directory, "inst-a", { pidAlive }), 1);
  assert.equal(liveLeaseCount(directory, "inst-b", { pidAlive }), 1);
  assert.equal(liveLeaseCount(directory, "inst-c", { pidAlive }), 0);
});

test("a bridge without a lease directory or instance holds no leases", (t) => {
  const directory = leaseDir(t);
  writeFileSync(path.join(directory, leaseFileName("inst-a", "one")), `${process.pid}\n`);

  assert.equal(liveLeaseCount(null, "inst-a"), 0);
  assert.equal(liveLeaseCount(directory, null), 0);
  assert.equal(liveLeaseCount(path.join(directory, "missing"), "inst-a"), 0);
});

test("a bridge that was never retired never exits by itself", () => {
  const time = clock();
  const retirement = new Retirement({ idleMs: 1_000, now: time.now });

  time.advance(10_000);
  assert.equal(retirement.readyToExit(), false);
});

test("a retired bridge waits out a full idle window after its last request", () => {
  const time = clock();
  const retirement = new Retirement({ idleMs: 1_000, now: time.now });

  assert.equal(retirement.retire(), true);
  // A second signal is not a second transition.
  assert.equal(retirement.retire(), false);
  assert.equal(retirement.readyToExit(), false);

  time.advance(600);
  retirement.begin();
  retirement.end();
  time.advance(600);
  // 1200ms since retiring, but only 600ms since the last request ended.
  assert.equal(retirement.readyToExit(), false);
  time.advance(400);
  assert.equal(retirement.readyToExit(), true);
});

test("a retired bridge never exits under an in-flight request", () => {
  const time = clock();
  const retirement = new Retirement({ idleMs: 1_000, now: time.now });

  retirement.begin();
  retirement.retire();
  // A request longer than the idle window is still a request.
  time.advance(5_000);
  assert.equal(retirement.readyToExit(), false);
  assert.equal(retirement.status().inFlight, 1);

  retirement.end();
  assert.equal(retirement.readyToExit(), false);
  time.advance(1_000);
  assert.equal(retirement.readyToExit(), true);
});

test("a retired bridge stays up while a launcher that started on it is alive", (t) => {
  const directory = leaseDir(t);
  const time = clock();
  const live = new Set([4242]);
  const retirement = new Retirement({
    instanceId: "inst-a",
    leaseDir: directory,
    idleMs: 1_000,
    now: time.now,
    pidAlive: (pid) => live.has(pid),
  });
  writeFileSync(path.join(directory, leaseFileName("inst-a", "tui")), "4242\n");

  retirement.retire();
  // An open session can sit idle for longer than the window; its launcher is
  // what says it is still there.
  time.advance(60_000);
  assert.equal(retirement.readyToExit(), false);
  assert.equal(retirement.status().leases, 1);

  // A launcher that was killed leaves its lease behind, naming a dead PID.
  live.delete(4242);
  assert.equal(retirement.readyToExit(), true);
});

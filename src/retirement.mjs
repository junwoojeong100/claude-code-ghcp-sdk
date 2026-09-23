import fs from "node:fs";
import path from "node:path";

// Every interactive launch shares the persistent bridge, so replacing it on a
// fingerprint change must not cut off the sessions still pointed at it: their
// settings files carry its port and token, and nothing can re-point them. A
// replaced bridge is retired instead -- it keeps serving, and exits once no
// launcher that started on it is still alive and it has gone a full idle
// window without a request. The idle window covers the sessions that hold no
// lease: a job handed to Claude Code's daemon with /background, whose launcher
// has already exited, and callers such as LiteLLM that never had one.

export const DEFAULT_RETIRED_IDLE_MS = 60 * 60 * 1000;

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

// A lease is one file per launcher, named for the bridge instance it started
// on and holding that launcher's PID. The launcher removes it on a clean exit;
// one left behind by a killed launcher names a dead PID and counts for nothing.
export function leaseFileName(instanceId, suffix) {
  return `${instanceId}.${suffix}.pid`;
}

export function liveLeaseCount(
  leaseDir,
  instanceId,
  { pidAlive = defaultPidAlive } = {},
) {
  if (!leaseDir || !instanceId) return 0;
  let entries;
  try {
    entries = fs.readdirSync(leaseDir);
  } catch {
    return 0;
  }
  let live = 0;
  for (const entry of entries) {
    if (!entry.startsWith(`${instanceId}.`) || !entry.endsWith(".pid")) continue;
    let pid;
    try {
      pid = Number(fs.readFileSync(path.join(leaseDir, entry), "utf8").trim());
    } catch {
      continue;
    }
    if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) live += 1;
  }
  return live;
}

export class Retirement {
  constructor({
    instanceId = null,
    leaseDir = null,
    idleMs = DEFAULT_RETIRED_IDLE_MS,
    now = Date.now,
    pidAlive = defaultPidAlive,
  } = {}) {
    this.instanceId = instanceId;
    this.leaseDir = leaseDir;
    this.idleMs = idleMs;
    this.now = now;
    this.pidAlive = pidAlive;
    this.inFlight = 0;
    this.lastActivity = now();
    this.retired = false;
  }

  begin() {
    this.inFlight += 1;
    this.lastActivity = this.now();
  }

  end() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastActivity = this.now();
  }

  // Returns true only on the transition, so a repeated signal is harmless.
  retire() {
    if (this.retired) return false;
    this.retired = true;
    return true;
  }

  status() {
    return {
      retired: this.retired,
      inFlight: this.inFlight,
      idleMs: this.now() - this.lastActivity,
      leases: liveLeaseCount(this.leaseDir, this.instanceId, {
        pidAlive: this.pidAlive,
      }),
    };
  }

  readyToExit() {
    if (!this.retired || this.inFlight > 0) return false;
    if (this.now() - this.lastActivity < this.idleMs) return false;
    return (
      liveLeaseCount(this.leaseDir, this.instanceId, {
        pidAlive: this.pidAlive,
      }) === 0
    );
  }
}

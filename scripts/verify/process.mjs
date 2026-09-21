/** Bounded asynchronous commands for verification, never a shell or shared process group. */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { MAX_TIMEOUT_MS } from "./timeouts.mjs";

/**
 * Resolve command failures as data, like spawnSync's status/error/signal/stdout/stderr.
 * Each pipe retains at most maxBuffer bytes (1 MiB by default). A timeout, abort,
 * stream error or overflow terminates only this child's group: TERM, then KILL
 * after killGraceMs. Normal completion never kills intentionally detached work.
 */
export function runProcess(file, args = [], {
  cwd,
  env = process.env,
  timeoutMs = 120_000,
  killGraceMs = 5000,
  maxBuffer = 1024 * 1024,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const result = {
      pid: null, status: null, signal: null, error: undefined,
      stdout: "", stderr: "", timedOut: false, aborted: false, completed: false,
      stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
    };
    const output = {
      stdout: { chunks: [], bytes: 0 },
      stderr: { chunks: [], bytes: 0 },
    };
    const grouped = process.platform !== "win32";
    let child;
    let timer;
    let killTimer;
    let drainTimer;
    let closed = false;
    let stopping = false;
    let killed = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener?.("abort", onAbort);
      for (const name of ["stdout", "stderr"]) {
        const { chunks, bytes } = output[name];
        const decoder = new StringDecoder("utf8");
        // Decode after collecting bytes, so pipe chunk boundaries cannot corrupt
        // UTF-8. On overflow, omit an incomplete final character rather than
        // expanding the cut bytes into a replacement character.
        result[name] = decoder.write(Buffer.concat(chunks, bytes));
        if (!result[`${name}Truncated`]) result[name] += decoder.end();
      }
      result.durationMs = Date.now() - startedAt;
      // A SIGTERM handler can exit zero after a timeout or cancellation.
      result.completed = closed && result.status === 0 && result.signal === null &&
        !result.error && !result.timedOut && !result.aborted &&
        !result.stdoutTruncated && !result.stderrTruncated;
      resolve(result);
    };

    const groupAlive = () => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
      if (!grouped) return child.exitCode === null && child.signalCode === null;
      try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
    };
    const killOwned = (killSignal) => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
      if (grouped) {
        try { process.kill(-child.pid, killSignal); return; } catch {}
      }
      // Never fall back to a PID whose child has already exited.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(killSignal); } catch {}
      }
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true;
      result.error ??= error;
      clearTimeout(timer);
      if (!child?.pid) { finish(); return; }
      killOwned("SIGTERM");
      killTimer = setTimeout(() => {
        killed = true;
        killOwned("SIGKILL");
        if (closed) { finish(); return; }
        // A descendant that deliberately detached can retain a pipe after the
        // owned group dies. Do not hunt it down or wait forever for its EOF.
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        }, 1000);
      }, killGraceMs);
    };
    const onAbort = () => {
      if (settled || stopping) return;
      result.aborted = true;
      stop(Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
        name: "AbortError", code: "ABORT_ERR",
      }));
    };
    const collect = (name, chunk) => {
      if (settled) return;
      const stream = output[name];
      const remaining = maxBuffer - stream.bytes;
      const kept = Math.min(remaining, chunk.length);
      if (kept > 0) {
        stream.chunks.push(Buffer.from(chunk.subarray(0, kept)));
        stream.bytes += kept;
      }
      if (chunk.length > remaining) {
        result[`${name}Truncated`] = true;
        stop(Object.assign(new Error(`${name} exceeded maxBuffer (${maxBuffer} bytes)`), { code: "ENOBUFS" }));
      }
    };

    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
          !Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > MAX_TIMEOUT_MS ||
          !Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
        throw new RangeError("timeoutMs, killGraceMs and maxBuffer must be finite bounded integer limits");
      }
      if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
        throw new TypeError("signal must be an AbortSignal");
      }
      if (signal?.aborted) { onAbort(); return; }
      child = spawn(file, args, {
        cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: grouped, windowsHide: true,
      });
      result.pid = child.pid ?? null;
    } catch (error) {
      result.error = error;
      finish();
      return;
    }

    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.once("error", stop);
    child.once("exit", (code, exitSignal) => {
      result.status = code;
      result.signal = exitSignal;
    });
    child.once("close", (code, exitSignal) => {
      closed = true;
      result.status = code !== null && code >= 0 ? code : null;
      result.signal = exitSignal;
      // A TERM handler can exit the leader while its child ignores TERM. Keep
      // the escalation armed for that group even though the leader's pipes closed.
      if (!stopping || killed || !groupAlive()) finish();
    });
    timer = setTimeout(() => {
      if (settled || stopping) return;
      result.timedOut = true;
      stop(Object.assign(new Error(`Command timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, Math.max(1, timeoutMs - (Date.now() - startedAt)));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

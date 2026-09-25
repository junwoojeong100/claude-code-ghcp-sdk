/** Synthetic PTY children only: no CLI, provider, or recorded evidence. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("../scripts/verify/pty.py", import.meta.url));
const decoded = records => Buffer.concat(records.filter(row => row.type === "output").map(row => Buffer.from(row.data, "base64")));

async function runPTY(t, script, { wrapper, spec = {}, onRecord = () => {}, ok = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-pty-order-"));
  const fixture = path.join(cwd, "child.py");
  fs.writeFileSync(fixture, `import os, signal, time, tty\ntty.setraw(0)\n${script}\n`);
  const config = JSON.stringify({ argv: ["python3", fixture], cwd, timeoutMs: 5000, maxBytes: 1024 * 1024, ...spec });
  const child = spawn("python3", wrapper ? ["-c", wrapper, HELPER, config] : [HELPER, config], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  let stderr = "", buffered = "", parseError, pid;
  const kill = () => {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const watchdog = setTimeout(kill, 8000);
  t.after(() => { clearTimeout(watchdog); kill(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const send = (sequence, data) => child.stdin.write(JSON.stringify({ type: "input", sequence, data: Buffer.from(data).toString("base64") }) + "\n");
  child.stdin.on("error", error => { parseError ??= error; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try {
        const row = JSON.parse(line); records.push(row);
        if (row.type === "start") pid = row.pid;
        onRecord(row, send);
      } catch (error) { parseError ??= error; kill(); }
    }
  });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve([code, signal]));
  });
  clearTimeout(watchdog);
  assert.ifError(parseError);
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.equal(buffered, "");
  const receipt = records.at(-1);
  assert.equal(receipt.type, "exit");
  if (ok) {
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.deepEqual(receipt.remainingPids, []);
  }
  assert.equal(receipt.groupGone, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const outputs = records.filter(row => row.type === "output");
  assert.deepEqual(outputs.map(row => row.sequence), outputs.map((_, i) => i + 1));
  return { records, receipt };
}

// macOS PTYs may buffer only 1024 bytes. Gate the final pre-key tail on control
// parsing, then force legal short reads so multiple reads are required on every
// OS. All bytes still come from a real child through the helper's actual PTY.
const SHORT_READ_GATE = `
import os, runpy, sys, time
read = os.read
short_reads = False
def gated_read(fd, size):
    global short_reads
    if fd == 0:
        data = read(fd, size)
        if data:
            open("release-tail", "w").close()
            deadline = time.monotonic() + 3
            while not os.path.exists("tail-written"):
                if time.monotonic() >= deadline:
                    raise RuntimeError("fixture did not finish its pre-key tail")
                time.sleep(0.001)
            short_reads = True
        return data
    return read(fd, min(size, 128) if short_reads and os.isatty(fd) else size)
os.read = gated_read
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

test("PTY ACK follows every known pre-key burst byte and precedes the post-key sentinel", { timeout: 10000 }, async t => {
  const prefix = "p".repeat(128 * 1024), tail = "t".repeat(512), sentinel = "POST_KEY";
  let received = 0, sent = false;
  const { records, receipt } = await runPTY(t, `
data = b"p" * ${prefix.length}
while data:
    data = data[os.write(1, data):]
while not os.path.exists("release-tail"):
    time.sleep(0.001)
data = b"t" * ${tail.length}
while data:
    data = data[os.write(1, data):]
open("tail-written", "w").close()
assert os.read(0, 1) == b"k"
os.write(1, b"${sentinel}")
`, { wrapper: SHORT_READ_GATE, onRecord(row, send) {
    if (row.type !== "output") return;
    received += Buffer.from(row.data, "base64").length;
    if (!sent && received >= prefix.length) { sent = true; send(1, "k"); }
  } });
  const index = records.findIndex(row => row.type === "input_ack");
  assert.ok(index > 0, "missing full-write ACK");
  const ack = records[index];
  assert.deepEqual(Object.keys(ack).sort(), ["type", "sequence", "byteCount", "outputSequence", "elapsedMs", "accepted"].sort());
  assert.equal(ack.sequence, 1); assert.equal(ack.byteCount, 1); assert.equal(ack.accepted, true);
  assert.equal(ack.outputSequence, records.slice(0, index).filter(row => row.type === "output").at(-1).sequence);
  assert.equal(decoded(records.slice(0, index)).toString(), prefix + tail);
  assert.equal(decoded(records.slice(index + 1)).toString(), sentinel);
  assert.equal(receipt.reason, null); assert.equal(receipt.exitCode, 0);
});

test("partial PTY writes retain full byte counts and ordered input sequences", { timeout: 10000 }, async t => {
  const size = 128 * 1024;
  let sent = false;
  const { records } = await runPTY(t, `
os.write(1, b"READY")
remaining = ${size}
while remaining:
    data = os.read(0, min(remaining, 1024))
    assert data and data == b"a" * len(data)
    remaining -= len(data)
assert os.read(0, 1) == b"z"
os.write(1, b"RECEIVED_ALL")
`, { onRecord(row, send) {
    if (row.type === "output" && !sent) { sent = true; send(1, "a".repeat(size)); send(2, "z"); }
  } });
  assert.deepEqual(records.filter(row => row.type === "input_ack").map(({ sequence, byteCount, accepted }) => ({ sequence, byteCount, accepted })), [
    { sequence: 1, byteCount: size, accepted: true }, { sequence: 2, byteCount: 1, accepted: true },
  ]);
  assert.equal(decoded(records).toString(), "READYRECEIVED_ALL");
});

for (const reason of ["deadline", "output_limit"]) {
  test(`streaming with queued input cannot prevent ${reason} cleanup`, { timeout: 10000 }, async t => {
    let sent = false;
    const maxBytes = reason === "deadline" ? 64 * 1024 * 1024 : 4096;
    const { records, receipt } = await runPTY(t, `
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    os.write(1, b"x" * 4096)
    time.sleep(0.0001)
`, { spec: { timeoutMs: reason === "deadline" ? 300 : 5000, maxBytes }, onRecord(row, send) {
      if (row.type === "output" && !sent) { sent = true; send(1, "k"); }
    } });
    assert.equal(receipt.reason, reason);
    assert.equal(receipt.escalated, true);
    assert.equal(receipt.signal, "SIGKILL");
    assert.ok(receipt.durationMs < 4500, `cleanup took ${receipt.durationMs}ms`);
    assert.ok(decoded(records).length <= maxBytes);
    if (reason === "output_limit") assert.ok(receipt.bytes > maxBytes);
  });
}

// Rewrites only the helper's ps samples: the listed PIDs appear as children of the
// PTY child with a fixed start time until a "reused" file exists. The wrapper never
// sends a signal; os.kill is intercepted only for the synthetic denied PID.
const FAKE_PS = ({ adopt, denied = null }) => `
import os, runpy, subprocess, sys
state = {}
real_forkpty, real_run, real_kill = os.forkpty, subprocess.run, os.kill
def forkpty():
    pid, fd = real_forkpty()
    if pid:
        state["cli"] = pid
    return pid, fd
def run(args, *rest, **kwargs):
    result = real_run(args, *rest, **kwargs)
    if args[0] == "/bin/ps" and "cli" in state:
        reused = os.path.exists("reused")
        if not reused:
            start = " Thu Jan  1 00:00:00 1970" if "lstart" in args[2] else ""
            result.stdout += "".join(f"{p} {state['cli']}{start}\\n" for p in ${JSON.stringify(adopt)})
        open("reused-seen" if reused else "adopted-seen", "w").close()
    return result
def kill(target, sig):
    if target == ${denied ?? "None"}:
        raise PermissionError(1, "synthetic foreign process")
    return real_kill(target, sig)
os.forkpty, subprocess.run, os.kill = forkpty, run, kill
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
const adoptThenExit = ({ reuse }) => `
os.write(1, b"READY")
def wait(name):
    deadline = time.monotonic() + 4
    while not os.path.exists(name):
        assert time.monotonic() < deadline, name
        time.sleep(0.01)
wait("adopted-seen")
${reuse ? 'open("reused", "w").close()\nwait("reused-seen")' : ""}
`;

test("a sampled descendant PID reused by another process is neither signalled nor remaining", { timeout: 10000 }, async t => {
  // The bystander is this test's own process; it stands in for an unrelated
  // process that received a recorded descendant's PID after that child exited.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-pty-reuse-")), term = path.join(dir, "term");
  const bystander = spawn("python3", ["-c", "import signal, sys, time\ndef term(*_):\n    open(sys.argv[1], 'w').close()\n    sys.exit(0)\nsignal.signal(signal.SIGTERM, term)\nprint('ready', flush=True)\ntime.sleep(30)", term], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { bystander.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(bystander.stdout, "data");
  const { receipt } = await runPTY(t, adoptThenExit({ reuse: true }), { wrapper: FAKE_PS({ adopt: [bystander.pid] }) });
  assert.ok(receipt.sampledChildPids.includes(bystander.pid), "fixture must first track the PID as a descendant");
  assert.equal(receipt.reason, null); assert.equal(receipt.escalated, false);
  assert.deepEqual(receipt.signalDeniedPids, []);
  assert.equal(fs.existsSync(term), false, "reused PID received SIGTERM");
  assert.equal(bystander.exitCode, null); assert.equal(bystander.signalCode, null);
  assert.doesNotThrow(() => process.kill(bystander.pid, 0));
});

test("a descendant that cannot be signalled is reported without losing the exit record", { timeout: 10000 }, async t => {
  const denied = 2 ** 30 + 7; // Never a real PID; every os.kill on it is intercepted.
  const { receipt } = await runPTY(t, adoptThenExit({ reuse: false }), { wrapper: FAKE_PS({ adopt: [denied], denied }), ok: false });
  assert.equal(receipt.reason, "descendant_cleanup"); assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.signalDeniedPids, [denied]);
  assert.deepEqual(receipt.remainingPids, [denied]);
  assert.equal(receipt.ok, false);
});

// Fails exactly one ps sample once "fail-ps" exists, either with a non-zero exit or
// as a zero-exit listing without the helper itself. "adopted-seen" marks a real
// sample that lists the detached child under the PTY child.
const FAIL_PS = returncode => `
import os, runpy, subprocess, sys
state = {}
real_forkpty, real_run = os.forkpty, subprocess.run
def forkpty():
    pid, fd = real_forkpty()
    if pid:
        state["cli"] = pid
    return pid, fd
def run(args, *rest, **kwargs):
    if args[0] == "/bin/ps" and os.path.exists("fail-ps") and "failed" not in state:
        state["failed"] = True
        return subprocess.CompletedProcess(args, ${returncode}, "", "")
    result = real_run(args, *rest, **kwargs)
    if args[0] == "/bin/ps" and os.path.exists("gpid"):
        row = [open("gpid").read(), str(state["cli"])]
        if any(line.split()[:2] == row for line in result.stdout.splitlines()):
            open("adopted-seen", "w").close()
    return result
os.forkpty, subprocess.run = forkpty, run
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
const DETACH_THEN_EXIT = `
import subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.write(1, b"GPID=%d;" % child.pid)
with open("gpid.tmp", "w") as f:
    f.write(str(child.pid))
os.replace("gpid.tmp", "gpid")
deadline = time.monotonic() + 4
while not os.path.exists("adopted-seen"):
    assert time.monotonic() < deadline
    time.sleep(0.01)
open("fail-ps", "w").close()
os._exit(0)
`;

for (const [label, returncode] of [["exits non-zero", 1], ["omits the helper itself", 0]]) {
  test(`a ps sample that ${label} cannot untrack a detached descendant`, { timeout: 10000 }, async t => {
    let text = "", gpid;
    t.after(() => { if (gpid) { try { process.kill(gpid, "SIGKILL"); } catch {} } });
    const { receipt } = await runPTY(t, DETACH_THEN_EXIT, { wrapper: FAIL_PS(returncode), onRecord(row) {
      if (row.type !== "output") return;
      text += Buffer.from(row.data, "base64").toString();
      gpid ??= Number(/GPID=(\d+);/.exec(text)?.[1]) || undefined;
    } });
    assert.ok(gpid && receipt.sampledChildPids.includes(gpid), JSON.stringify(receipt));
    assert.equal(receipt.reason, "descendant_cleanup"); assert.equal(receipt.exitCode, 0);
    assert.throws(() => process.kill(gpid, 0), { code: "ESRCH" }, "detached descendant survived cleanup");
  });
}

test("docs state the helper's ps sampling scope and its Python 3.9 minimum", () => {
  const read = name => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
  const source = read("scripts/verify/pty.py");
  assert.match(source, /now - last_sample >= 0\.25:/);
  assert.match(source, /os\.waitstatus_to_exitcode\(/); // Added in Python 3.9.
  const flat = name => read(name).replace(/\s+/g, " ");
  assert.match(flat("docs/DIAGNOSTICS.md"), /sampling `ps` about every 0\.25 s, so a process that detaches[^.]*not observed/);
  assert.match(flat("docs/DIAGNOSTICS_KO.md"), /약 0\.25초마다 `ps` 표본[^.]*관측하지 못하며/);
  assert.match(flat("docs/TESTING.md"), /Python 3\.9 or newer, available as `python3` on PATH/);
  assert.match(flat("docs/TESTING_KO.md"), /`python3`로 PATH에 있고[^.]*Python 3\.9 이상/);
});

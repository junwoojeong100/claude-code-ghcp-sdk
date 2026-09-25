#!/usr/bin/env python3
"""One owned PTY, bounded JSON-line control, and a process-group cleanup receipt."""
import base64
from collections import deque
import errno
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def emit(kind, **fields):
    sys.stdout.write(json.dumps({"type": kind, **fields}, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    spec = json.loads(sys.argv[1])
    timeout = spec.get("timeoutMs", 420000) / 1000
    limit = spec.get("maxBytes", 4 * 1024 * 1024)
    if not 0 < timeout <= 86400 or not 0 < limit <= 64 * 1024 * 1024:
        raise ValueError("invalid PTY limits")
    pid, master = os.forkpty()
    if pid == 0:
        os.chdir(spec["cwd"])
        os.execvpe(spec["argv"][0], spec["argv"], os.environ)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", spec.get("rows", 42), spec.get("cols", 140), 0, 0))
    os.set_blocking(master, False)
    os.set_blocking(sys.stdin.fileno(), False)
    emit("start", pid=pid, pgid=pid, helperPid=os.getpid())
    started = time.monotonic()
    stopping = None
    status = None
    reason = None
    killed = False
    total = 0
    control = b""
    pending = deque()
    pending_bytes = 0
    output_sequence = 0
    input_sequence = 0
    pty_open = True
    input_open = True
    tracked = {}  # pid -> ps start time at the latest identity-verified sample
    sampled = set()
    denied = set()
    last_sample = 0

    def alive(target):
        try:
            os.kill(target, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def sample():
        # A bounded best-effort sample, not proof of every process ever created.
        # Rebuild from current rows: a tracked PID survives only while its start
        # time matches, so a reused PID (and its children) is never adopted.
        try:
            result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,lstart="], capture_output=True, text=True, timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            return False
        rows = {}
        for line in result.stdout.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3 and parts[0].isdecimal() and parts[1].isdecimal():
                rows[int(parts[0])] = (int(parts[1]), " ".join(parts[2].split()))
        if result.returncode != 0 or os.getpid() not in rows:
            return False  # A failed or partial listing proves nothing; keep the last verified identities.
        current = {p: start for p, start in tracked.items() if p in rows and rows[p][1] == start}
        # A reaped CLI PID can itself be reused; it roots the tree only while unreaped.
        parents = set(current) | ({pid} if status is None else set())
        changed = True
        while changed:
            changed = False
            for child, (parent, start) in rows.items():
                if parent in parents and child not in parents:
                    current[child] = start
                    parents.add(child)
                    changed = True
        tracked.clear()
        tracked.update(current)
        sampled.update(current)
        return True

    def live():
        for p in [p for p in tracked if not alive(p)]:
            del tracked[p]
        return bool(tracked)

    def send(sig):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        if not sample():
            return  # Identity is unverifiable: never signal an individual PID.
        for child in list(tracked):
            try:
                os.kill(child, sig)
            except ProcessLookupError:
                tracked.pop(child, None)
            except PermissionError:
                denied.add(child)

    def stop(why):
        nonlocal stopping, reason
        if stopping is None:
            reason = why
            stopping = time.monotonic()
            send(signal.SIGTERM)

    def read_output():
        nonlocal pty_open, total, output_sequence
        try:
            data = os.read(master, 65536)
        except OSError as exc:
            if exc.errno == errno.EINTR:
                return True
            if exc.errno != errno.EAGAIN:
                pty_open = False
            return False
        if not data:
            pty_open = False
            return False
        total += len(data)
        if total > limit:
            stop("output_limit")
        else:
            output_sequence += 1
            emit("output", sequence=output_sequence, data=base64.b64encode(data).decode("ascii"))
        return True

    def drain_before_input():
        # Read through EAGAIN, not just one chunk. A streaming writer must still
        # yield to the deadline/output limit so the outer loop can finish cleanup.
        while pty_open and stopping is None:
            if time.monotonic() - started >= timeout:
                stop("deadline")
                return False
            if not read_output():
                return pty_open
        return False

    def on_signal(_sig, _frame):
        stop("controller_signal")

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        while True:
            now = time.monotonic()
            if now - last_sample >= 0.25:
                sample()
                last_sample = now
            if now - started >= timeout:
                stop("deadline")
            if stopping is not None and now - stopping >= 1 and not killed:
                killed = True
                send(signal.SIGKILL)
            if status is None:
                waited, value = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = value
                    if alive(-pid) or live():
                        stop("descendant_cleanup")
            if status is not None and not alive(-pid) and not live():
                # Drain final bytes, within the same output and time bounds.
                while pty_open and total <= limit and time.monotonic() - started < timeout:
                    if not read_output():
                        break
                break
            if stopping is not None and now - stopping >= 3:
                break
            readers = ([master] if pty_open else []) + ([sys.stdin.fileno()] if input_open else [])
            readable, writable, _ = select.select(readers, [master] if pending and pty_open else [], [], 0.05)
            if master in readable:
                read_output()
            if master in writable and pty_open and stopping is None and drain_before_input():
                # The ACK proves a full PTY write, not application receipt or
                # perfect causality with output produced concurrently with it.
                item = pending[0]
                try:
                    count = os.write(master, item["data"][item["written"]:])
                    item["written"] += count
                    pending_bytes -= count
                    if item["written"] == len(item["data"]):
                        pending.popleft()
                        emit("input_ack", sequence=item["sequence"], byteCount=item["written"],
                             outputSequence=output_sequence,
                             elapsedMs=round((time.monotonic() - started) * 1000), accepted=True)
                except OSError as exc:
                    if exc.errno not in (errno.EAGAIN, errno.EINTR):
                        stop("pty_write_error")
            if sys.stdin.fileno() in readable:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    input_open = False
                    stop("controller_eof")
                control += chunk
                if len(control) > limit:
                    stop("input_limit")
                while b"\n" in control:
                    line, control = control.split(b"\n", 1)
                    message = json.loads(line)
                    if message.get("type") == "input":
                        sequence = message.get("sequence")
                        data = base64.b64decode(message["data"], validate=True)
                        if type(sequence) is not int or sequence != input_sequence + 1 or not data:
                            raise ValueError("invalid PTY input sequence")
                        input_sequence = sequence
                        pending_bytes += len(data)
                        if pending_bytes > limit or len(pending) >= 4096:
                            stop("input_limit")
                        elif stopping is None:
                            pending.append({"sequence": sequence, "data": data, "written": 0})
                    elif message.get("type") == "close":
                        stop("controller_close")
    finally:
        if status is None or alive(-pid) or live():
            send(signal.SIGKILL)
        if status is None:
            waited, value = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = value
        os.close(master)
        group_gone = not alive(-pid)
        sample()
        remaining = sorted(p for p in tracked if alive(p))
        exit_code = os.waitstatus_to_exitcode(status) if status is not None else None
        emit("exit", pid=pid, pgid=pid, exitCode=exit_code if exit_code is not None and exit_code >= 0 else None,
             signal=signal.Signals(-exit_code).name if exit_code is not None and exit_code < 0 else None,
             groupGone=group_gone, sampledChildPids=sorted(sampled), remainingPids=remaining,
             signalDeniedPids=sorted(denied),
             reason=reason, escalated=killed, bytes=total, durationMs=round((time.monotonic() - started) * 1000),
             ok=status is not None and group_gone and not remaining)


if __name__ == "__main__":
    main()

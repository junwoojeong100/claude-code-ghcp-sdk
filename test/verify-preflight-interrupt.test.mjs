/** Local preflight interruption orchestration; no installed CLI or provider. */
import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalInterruption } from "../scripts/verify/preflight.mjs";

function fixture({ visible = true, receipt = true, ready = true, closes = true, early = false } = {}) {
  const api = { records: [] }, calls = [];
  let resolve, reject, submitted = 0, abortListener, pendingSignal;
  const native = {
    pid: 101, sessionId: "local-session", activeSubmit: false,
    activity: () => ({ interruptible: visible, ready }),
    async submit(prompt, { signal } = {}) {
      calls.push(prompt);
      if (submitted++) return { answer: "LOCAL_RECOVERED" };
      this.activeSubmit = true;
      if (early) { this.activeSubmit = false; return { interrupted: false }; }
      api.records.push({ type: "request", id: "one" });
      if (visible) api.records.push({ type: "progress", id: "one" });
      pendingSignal = signal;
      return new Promise((yes, no) => {
        resolve = yes; reject = no;
        abortListener = () => { this.activeSubmit = false; calls.push("observer-aborted"); reject(new Error("observer aborted")); };
        signal.addEventListener("abort", abortListener, { once: true });
      });
    },
    async waitFor(predicate) {
      // Let an already completed submit settle before testing readiness.
      await new Promise(resolve => setImmediate(resolve));
      if (!predicate()) throw new Error("Local wait deadline");
    },
    async escape({ purpose }) {
      calls.push(purpose);
      if (purpose === "test-interrupt") {
        pendingSignal.removeEventListener("abort", abortListener);
        this.activeSubmit = false;
        if (closes) api.records.push({ type: "response", id: "one", aborted: true, finished: false });
        const event = { type: "user", session_id: this.sessionId, message: { content: "[Request interrupted by user]" } };
        resolve({ events: [event], sessionId: this.sessionId, interrupted: true, interruption: {
          nativeReceipt: receipt ? { kind: "event", event, renderSequence: 2, outputSequence: 2, elapsedMs: 2 } : null,
          escapeSequence: 1, renderSequence: 2, outputSequence: 2, screen: "❯\n", ready } });
      }
      return { kind: "escape", purpose, accepted: true, byteCount: 1, sequence: 1,
        renderSequence: 1, outputSequence: 1, writeOutputSequence: 1, elapsedMs: 1, acknowledgedMs: 1 };
    },
  };
  return { native, api, calls };
}

test("local interruption recovers only after native readiness and response closure", async () => {
  const { native, api, calls } = fixture();
  const result = await checkLocalInterruption(native, api, "LOCAL_LONG_STREAM");
  assert.equal(result.id, "one");
  assert.equal(result.receipt.purpose, "test-interrupt");
  assert.deepEqual(calls, ["LOCAL_LONG_STREAM", "test-interrupt", "LOCAL_REPLY=LOCAL_RECOVERED"]);
});

for (const [name, options] of [["missing native receipt", { receipt: false }], ["not ready", { ready: false }], ["missing close", { closes: false }]]) {
  test(`local interruption does not recover with ${name}`, async () => {
    const { native, api, calls } = fixture(options);
    await assert.rejects(checkLocalInterruption(native, api, "LOCAL_LONG_STREAM"));
    assert.equal(native.activeSubmit, false);
    assert.ok(!calls.includes("LOCAL_REPLY=LOCAL_RECOVERED"));
    assert.equal(calls.filter(c => c === "test-interrupt").length, 1);
  });
}

test("no visible progress cancels and awaits the observer as cleanup, never a test Escape", async () => {
  const { native, api, calls } = fixture({ visible: false });
  await assert.rejects(checkLocalInterruption(native, api, "LOCAL_REASONING_STREAM"), /deadline/);
  assert.equal(native.activeSubmit, false);
  assert.deepEqual(calls, ["LOCAL_REASONING_STREAM", "cleanup", "observer-aborted"]);
});

test("early completion never receives an interruption key or a recovery prompt", async () => {
  const { native, api, calls } = fixture({ early: true });
  await assert.rejects(checkLocalInterruption(native, api, "LOCAL_REPLY=done"), /ended before/);
  assert.deepEqual(calls, ["LOCAL_REPLY=done"]);
});

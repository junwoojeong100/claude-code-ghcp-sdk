/** Exercise real driver orchestration with deterministic CLI/bridge doubles. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DRIVERS, evaluateStoredSlot } from "../scripts/verify/drivers.mjs";
import { SCENARIOS, PRIMARY_MODELS, switchSource } from "../scripts/verify/scenarios.mjs";
import { HeadlessRun } from "../scripts/verify/session.mjs";
import { copilotModelForFrontend, launchModelFor } from "../src/model-map.mjs";
import { makeSlot, assistant, run, compactRun, nativePolicy } from "./fixtures/verify-evidence.mjs";
import { digest } from "../scripts/verify/fixtures.mjs";
import { createTimeoutPolicy } from "../scripts/verify/timeouts.mjs";

function context(t, id, mutate = () => {}, interrupt = {}) {
  const template = makeSlot(t, id), f = template.evidence.facts;
  const slotDir = path.dirname(f.workspace), configDir = path.join(slotDir, "config");
  const settingsPath = path.join(slotDir, "settings.json"), logPath = path.join(slotDir, "bridge.log");
  fs.mkdirSync(configDir); fs.writeFileSync(settingsPath, "{}"); fs.writeFileSync(logPath, "");
  const ctx = { model: template.model, scenario: SCENARIOS.find(s => s.id === id), slotDir, configDir, settingsPath,
    workspace: f.workspace, fixture: f.fixture, preflight: { plugins: [] }, timeoutSeconds: 5,
    claudeBin: "/synthetic/claude", frontendModel: launchModelFor(id === "V04" ? switchSource(template.model) : template.model),
    bridge: { logPath, pid: 501 }, dependencies: {} };
  const append = rows => fs.appendFileSync(ctx.bridge.logPath, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const state = { calls: [], pid: 100, prompts: [], nonce: null, seedHash: null, history: [], closed: [], escapes: [], submitOptions: [], now: 100000, scheduled: [],
    phases: [], sdkGeneration: 0, compacted: false };
  state.schedule = (ms, fn) => {
    if (!ms) fn();
    else state.scheduled.push({ at: state.now + ms, fn });
  };
  if (id === "V05") {
    ctx.timeouts = createTimeoutPolicy(SCENARIOS, 0.01);
    ctx.deadline = state.now + ctx.timeouts.scenarioMs.V05;
    ctx.dependencies.now = () => state.now;
    ctx.dependencies.delay = async ms => {
      state.now += ms;
      const due = state.scheduled.filter(job => job.at <= state.now);
      state.scheduled = state.scheduled.filter(job => job.at > state.now);
      due.sort((a, b) => a.at - b.at).forEach(job => job.fn());
      await new Promise(resolve => setImmediate(resolve));
    };
  }
  const makeRun = (events, options) => {
    // Like the bridge: a compacted history or a restarted bridge gets a new SDK session.
    const result = run(events, { sdkSession: `sdk-${options.model}-${state.sdkGeneration}`, ...options }); mutate(result, state);
    append(result.observations); return result;
  };
  ctx.dependencies.runHeadless = async options => {
    state.calls.push("print"); state.prompts.push(options.prompt);
    const native = false, session = options.extraArgs.at(options.extraArgs.indexOf("--session-id") + 1);
    let result;
    if (id === "V02") {
      result = structuredClone(f.runs.coding);
      result.events.forEach(e => { e.session_id = session; });
      result.observations.filter(e => e.event === "bridge.verify_request").forEach(e => { e.claudeSessionId = session; });
      mutate(result, state); append(result.observations);
      fs.writeFileSync(path.join(f.workspace, f.fixture.sourceFile), f.fixture.fixedSource);
    } else {
      const answer = /Reply with exactly (VERIFY_[a-f0-9]+)/.exec(options.prompt)[1];
      result = makeRun([assistant("print-response", answer, session)], { native, session, root: slotDir, model: ctx.model });
    }
    result.cleanup = { ok: true, pid: 99, groupGone: true, exitCode: 0, signal: null };
    result.observedSessionId = session;
    return new HeadlessRun(result);
  };
  class FakeNative {
    constructor(options) {
      this.options = options; this.pid = ++state.pid; this.sessionId = options.sessionId;
      this.launchPolicy = nativePolicy(slotDir, options.tools, Object.keys(options.mcpConfig.mcpServers));
      this.model = copilotModelForFrontend(options.frontendModel); this.turn = 0;
      this.renderSequence = 10; this.outputSequence = 20; this.activeSubmit = false; this.busy = false;
      state.native = this;
      if (interrupt.noMarkPhase) this.markPhase = undefined;
    }
    markPhase(label) {
      assert.match(label, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/);
      state.phases.push({ label, pid: this.pid, calls: state.calls.length });
    }
    async start(options) { state.calls.push(options.resume ? "resume" : "launch"); if (id === "V05") state.now += interrupt.launchDelayMs ?? 0; }
    screen() { return this.busy ? "Working (esc to interrupt)" : "⎿ Interrupted · What should Claude do instead?\n❯"; }
    activity() { return { renderSequence: this.renderSequence, outputSequence: this.outputSequence, screen: this.screen(), active: this.busy,
      interruptible: this.busy && !interrupt.notInterruptible, ready: !this.busy }; }
    interruptResult(interrupted = true) {
      const event = { type: "user", session_id: this.sessionId, parent_tool_use_id: null,
        message: { role: "user", content: "[Request interrupted by user]" } };
      return { nativeTurn: true, sessionId: this.sessionId, pid: this.pid, launchPolicy: this.launchPolicy,
        screen: this.screen(), interrupted, interruption: { escapeSequence: this.interruptReceipt?.sequence,
          nativeReceipt: interrupted ? { kind: "event", event, renderSequence: this.renderSequence, outputSequence: this.outputSequence, elapsedMs: 3 } : null,
          ready: !this.busy, screen: this.screen(), renderSequence: this.renderSequence, outputSequence: this.outputSequence },
        events: interrupted ? [event] : [] };
    }
    readEvents() { return state.history; }
    async command(text) {
      state.calls.push(text);
      if (text === "/model") return { picker: { models: [...PRIMARY_MODELS], current: ctx.model } };
      if (text === "/clear") { this.sessionId = "new-session"; state.nonce = null; return {}; }
      if (text.startsWith("/model ")) { this.model = copilotModelForFrontend(text.slice(7)); return {}; }
      if (text === "/compact") {
        const result = compactRun({ root: slotDir, model: this.model, session: this.sessionId, pid: this.pid, sdkSession: `sdk-${this.model}-${state.sdkGeneration}` });
        if (!interrupt.staleCompactSession) state.sdkGeneration++;
        if (!interrupt.uncompactedHistory) state.compacted = true;
        state.history = structuredClone(result.events);
        append(result.observations);
        return { ...result, sessionId: this.sessionId, launchPolicy: this.launchPolicy };
      }
      return {};
    }
    async submit(prompt, options = {}) {
      assert.equal(this.activeSubmit, false, "recovery may not race the interruption observer");
      state.prompts.push(prompt); state.submitOptions.push(options);
      const hashes = [];
      const values = prompt.match(/VERIFY_[a-f0-9]+/g) ?? [];
      if (values.length >= 2) { state.nonce = values[0]; state.seedHash = digest(prompt); }
      if (state.seedHash && state.nonce && !state.compacted) hashes.push(state.seedHash);
      let answer = values.at(-1) ?? state.nonce;
      if (id === "V01" && values.length >= 2) answer += " 안녕 café";
      if (id === "V03") {
        const args = this.options.mcpConfig.mcpServers.fixture.args;
        answer = fs.readFileSync(args[1], "utf8");
        if (!this.turn) {
          const copied = structuredClone(f.runs.lookup);
          copied.events.forEach(e => { e.session_id = this.sessionId; });
          copied.observations.filter(e => e.event === "bridge.verify_request").forEach(e => { e.claudeSessionId = this.sessionId; });
          copied.events.find(e => e.message?.id === "lookup-final").message.content[0].text = answer;
          copied.events.find(e => e.message?.content?.[0]?.tool_use_id === "selected").message.content[0].content = answer;
          const ledger = structuredClone(f.mcpLedger); ledger.at(-1).result.content[0].text = answer;
          fs.writeFileSync(args[2], ledger.map(r => JSON.stringify(r)).join("\n") + "\n");
          Object.assign(copied, { pid: this.pid, observedSessionId: this.sessionId, sessionId: this.sessionId, launchPolicy: this.launchPolicy });
          this.turn++; append(copied.observations); return copied;
        }
      }
      if (id === "V05" && !this.turn) {
        const requestId = "interrupt-request", responseId = "interrupt-response";
        this.interruptedRequest = { requestId, responseId }; this.activeSubmit = true; this.busy = true;
        append([{ event: "bridge.verify_request", requestId, responseId, requestedModel: ctx.model, streaming: true,
          claudeAgent: interrupt.subagent ? "subagent" : "root", claudeSessionId: interrupt.wrongSession ? "other-session" : this.sessionId }]);
        if (interrupt.reasoningOnly || interrupt.textDelayMs) append([{ event: "bridge.verify_progress", requestId, responseId, kind: "assistant.reasoning_delta" }]);
        if (!interrupt.reasoningOnly) state.schedule(interrupt.textDelayMs, () => append([
          { event: "bridge.verify_progress", requestId, responseId: interrupt.wrongResponse ? "unrelated" : responseId, kind: "assistant.message_delta" },
        ]));
        return new Promise((resolve, reject) => {
          const finish = (value, error) => {
            this.activeSubmit = false; this.turn++; this.interruptResolve = null;
            options.signal?.removeEventListener("abort", onAbort);
            if (error) reject(error); else resolve(value);
          };
          const onAbort = () => {
            state.observerCancelled = true;
            finish(null, Object.assign(new Error("observer cancelled"), { result: this.interruptResult(false) }));
          };
          this.interruptResolve = value => finish(value);
          options.signal?.addEventListener("abort", onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
          if (interrupt.earlyComplete) state.schedule(50, () => {
            append([{ event: "bridge.turn_completed", requestId, responseId }]);
            this.busy = false; this.renderSequence++;
            this.interruptResolve?.(this.interruptResult(false));
          });
        });
      }
      if (id === "V05") { state.recoveryStartedAt = state.now; assert.equal(this.busy, false); }
      const response = makeRun([assistant(`native-${this.pid}-${this.turn++}`, answer, this.sessionId)], {
        root: slotDir, model: this.model, tools: this.options.tools, session: this.sessionId, pid: this.pid, hashes,
      });
      return { ...response, answer, sessionId: this.sessionId, completed: true };
    }
    async escape({ purpose, timeoutMs } = {}) {
      if (!["test-interrupt", "cleanup", "picker-dismiss"].includes(purpose)) throw new TypeError(`Escape purpose required: ${purpose}`);
      const receipt = { kind: "escape", purpose, sequence: state.escapes.length + 1, renderSequence: this.renderSequence,
        outputSequence: this.outputSequence, writeOutputSequence: this.outputSequence, elapsedMs: 1, acknowledgedMs: 2, accepted: true, byteCount: 1 };
      this.interruptReceipt = receipt;
      state.escapes.push({ ...receipt, timeoutMs, at: state.now, calls: state.calls.length });
      if (id !== "V05") return receipt;
      if (purpose === "cleanup") { this.busy = false; this.renderSequence++; return receipt; }
      append([
        { event: "bridge.turn_aborted", ...this.interruptedRequest, reason: "client_abort" },
        { event: "bridge.verify_response", ...this.interruptedRequest, finished: false, aborted: true },
      ]);
      if (!interrupt.missingAck) state.schedule(interrupt.ackDelayMs, () => append([
        { event: "bridge.turn_abort_completed", ...this.interruptedRequest, reason: "client_abort", acknowledged: !interrupt.unacknowledged },
      ]));
      if (!interrupt.neverSettle) state.schedule(interrupt.nativeDelayMs, () => {
        this.busy = false; this.renderSequence++; this.outputSequence++;
        this.interruptResolve?.(this.interruptResult(!interrupt.noNativeMarker));
      });
      if (interrupt.receiptLost) return undefined;
      if (interrupt.receiptError) throw new Error("native input receipt lost");
      return receipt;
    }
    async close() {
      state.closed.push(this.pid);
      return { ok: true, groupGone: true, exitCode: 0, signal: null, pid: this.pid };
    }
  }
  ctx.dependencies.InteractiveSession = FakeNative;
  ctx.restartBridge = async () => {
    state.calls.push("restartBridge"); state.sdkGeneration++;
    const settingsPath = path.join(slotDir, "settings-restarted.json"); fs.writeFileSync(settingsPath, "{}");
    return { bridge: { ...ctx.bridge, pid: 502, frontendModel: launchModelFor(ctx.model) }, settingsPath, cleanup: { ok: true } };
  };
  return { ctx, state };
}

for (const id of SCENARIOS.map(s => s.id)) test(`${id} live driver orchestrates deterministic offline transports`, async t => {
  const { ctx, state } = context(t, id);
  const result = await DRIVERS[id](ctx);
  assert.equal(result.outcome, "pass", result.reason);
  assert.equal(evaluateStoredSlot({ ...result, model: ctx.model, scenario: id }).outcome, "pass");
  assert.equal(state.closed.length, id === "V02" ? 0 : id === "V06" ? 2 : 1);
  if (id === "V06") {
    assert.deepEqual(state.calls, ["launch", "/compact", "restartBridge", "resume"]);
    assert.ok(state.prompts.slice(1).every(p => !p.includes(state.nonce)));
  }
  // Every native phase is marked in the recording, in order; print-mode phases have no terminal.
  const scenario = SCENARIOS.find(s => s.id === id);
  assert.deepEqual(state.phases.map(p => p.label), scenario.phases.map(p => p.id).filter(p => !["print", "coding"].includes(p)));
});

test("phase markers are optional for sessions without a recording", async t => {
  for (const id of ["V01", "V06"]) {
    const { ctx, state } = context(t, id, undefined, { noMarkPhase: true });
    const result = await DRIVERS[id](ctx);
    assert.equal(result.outcome, "pass", result.reason);
    assert.equal(state.phases.length, 0);
  }
});

test("V06 marks the resume phase in the resumed CLI after the bridge restart", async t => {
  const { ctx, state } = context(t, "V06");
  await DRIVERS.V06(ctx);
  const [seed, , , resume] = state.phases;
  assert.notEqual(seed.pid, resume.pid);
  assert.equal(resume.calls, state.calls.indexOf("resume") + 1);
});

test("V01 dismisses the model picker without a test-interrupt Escape", async t => {
  const { ctx, state } = context(t, "V01");
  const result = await DRIVERS.V01(ctx);
  assert.equal(result.outcome, "pass", result.reason);
  assert.deepEqual(state.escapes.map(e => e.purpose), ["picker-dismiss"]);
  assert.equal(state.escapes[0].calls, state.calls.indexOf("/model") + 1);
});

for (const [name, option] of [["reuses the pre-compaction SDK session", "staleCompactSession"], ["sends the uncompacted seed after compact", "uncompactedHistory"]]) {
  test(`V06 fails when the bridge ${name}`, async t => {
    const { ctx } = context(t, "V06", undefined, { [option]: true });
    const result = await DRIVERS.V06(ctx);
    assert.equal(result.outcome, "fail", result.reason);
    assert.match(result.reason, /after compact/);
    assert.equal(evaluateStoredSlot({ ...result, model: ctx.model, scenario: "V06" }).outcome, "fail");
  });
}

test("V01 Unicode seed ends with an unquoted standalone literal, independent of the response double", async t => {
  const { ctx, state } = context(t, "V01");
  const result = await DRIVERS.V01(ctx);
  const seed = state.prompts.find(p => p.startsWith("Remember the inert project label"));
  const literal = seed.split("\n").at(-1);
  assert.match(literal, /^VERIFY_[a-f0-9]+ 안녕 café$/u);
  assert.equal(digest(literal), result.evidence.facts.answers.unicode);
  assert.equal(digest(seed), result.evidence.facts.seedHash);
  assert.match(seed.split("\n")[0], /without quotes, punctuation, or any other text\.$/);
});

test("V05 waits through reasoning for delayed text, then for native readiness and SDK acknowledgment", async t => {
  const { ctx, state } = context(t, "V05", undefined, { textDelayMs: 700, nativeDelayMs: 50, ackDelayMs: 100 });
  const result = await DRIVERS.V05(ctx), f = result.evidence.facts, timing = f.interruptTiming;
  assert.equal(result.outcome, "pass", result.reason);
  assert.deepEqual(state.calls, ["launch"]); // No model or effort changes to obtain faster text.
  assert.equal(state.native.options.frontendModel, ctx.frontendModel);
  assert.match(state.prompts[0], /integers from 1 through 2000/);
  assert.equal(state.escapes.filter(e => e.purpose === "test-interrupt").length, 1);
  assert.ok(timing.escapeAt - timing.startedAt >= 700);
  assert.equal(timing.progressDeadline - timing.startedAt, 900);
  assert.ok(timing.requestObservedAt < timing.escapeAt);
  assert.ok(timing.recoveryStartedAt >= timing.ackAt && timing.ackAt > timing.settledAt);
  assert.equal(state.native.activeSubmit, false);
  assert.equal(state.submitOptions[1].timeoutMs, 600);
  assert.ok(timing.recoveryTurnDeadline <= ctx.deadline - ctx.timeouts.cleanupMs);
});

for (const [name, options, outcome, testEscapes] of [
  ["reasoning without text", { reasoningOnly: true }, "no-text-progress", 0],
  ["completion before text", { earlyComplete: true, textDelayMs: 100 }, "completed-before-interrupt", 0],
  ["text for another response", { wrongResponse: true }, "no-text-progress", 0],
  ["current UI not interruptible", { notInterruptible: true }, "native-not-interruptible", 0],
  ["lost accepted input receipt", { receiptLost: true }, "native-receipt-missing", 1],
  ["input receipt rejection", { receiptError: true }, "native-receipt-missing", 1],
  ["no actual native interruption marker", { noNativeMarker: true }, "native-interruption-unconfirmed", 1],
  ["missing SDK abort acknowledgment", { missingAck: true }, "abort-ack-missing", 1],
  ["late SDK abort acknowledgment", { ackDelayMs: 200 }, "abort-ack-missing", 1],
  ["negative SDK abort acknowledgment", { unacknowledged: true }, "abort-not-acknowledged", 1],
  ["unsettled native observer", { neverSettle: true }, "native-interruption-unconfirmed", 1],
]) test(`V05 does not recover after ${name}`, async t => {
  const { ctx, state } = context(t, "V05", undefined, options);
  const result = await DRIVERS.V05(ctx), f = result.evidence.facts;
  assert.notEqual(result.outcome, "pass", result.reason);
  assert.equal(f.interruptOutcome, outcome, result.reason);
  assert.equal(f.interruptRequestId, "interrupt-request");
  assert.ok(f.interruptObservations.some(r => r.event === "bridge.verify_request"));
  assert.equal(state.escapes.filter(e => e.purpose === "test-interrupt").length, testEscapes);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.native.activeSubmit, false);
  assert.equal(f.runs.recovery, undefined);
  assert.ok(state.now <= f.interruptTiming.interruptDeadline);
  assert.ok(f.interruptTiming.budgets && Number.isFinite(f.interruptTiming.progressDeadline));
  assert.notEqual(evaluateStoredSlot({ ...result, model: ctx.model, scenario: "V05" }).outcome, "pass");
  if (options.reasoningOnly || options.neverSettle) {
    assert.equal(state.observerCancelled, true);
    assert.equal(f.interruptTiming.observerCancelled, true);
    assert.equal(f.cleanupEscape.purpose, "cleanup");
  }
});

for (const options of [{ wrongSession: true }, { subagent: true }]) test("V05 ignores text outside the active root session", async t => {
  const { ctx, state } = context(t, "V05", undefined, options);
  const result = await DRIVERS.V05(ctx);
  assert.notEqual(result.outcome, "pass");
  assert.equal(state.escapes.filter(e => e.purpose === "test-interrupt").length, 0);
  assert.equal(result.evidence.facts.interruptRequestId, undefined);
  assert.equal(state.native.activeSubmit, false);
});

test("V05 reserves recovery and cleanup even after slow launch consumes the slot", async t => {
  const { ctx, state } = context(t, "V05", undefined, { launchDelayMs: 1400, textDelayMs: 100, ackDelayMs: 50 });
  const result = await DRIVERS.V05(ctx), timing = result.evidence.facts.interruptTiming;
  assert.equal(result.outcome, "pass", result.reason);
  assert.equal(timing.progressDeadline - timing.startedAt, 150);
  assert.ok(timing.recoveryTurnDeadline <= ctx.deadline - ctx.timeouts.cleanupMs);
  assert.equal(state.submitOptions[1].timeoutMs, ctx.timeouts.interrupt.recoveryMs);
});

test("V05 refuses to start a turn when remaining time would consume recovery reserve", async t => {
  const { ctx, state } = context(t, "V05", undefined, { launchDelayMs: 1550 });
  const result = await DRIVERS.V05(ctx);
  assert.notEqual(result.outcome, "pass");
  assert.equal(result.evidence.facts.interruptOutcome, "insufficient-phase-budget");
  assert.equal(state.prompts.length, 0);
  assert.equal(state.escapes.length, 0);
});

test("independent tests never execute changed test files", async t => {
  const { ctx } = context(t, "V02");
  const original = ctx.dependencies.runHeadless;
  ctx.dependencies.runHeadless = async options => {
    const result = await original(options);
    fs.appendFileSync(path.join(ctx.workspace, ctx.fixture.testFile), "// unexpected modification\n");
    return result;
  };
  let invoked = false;
  ctx.dependencies.runProcess = async () => { invoked = true; throw new Error("Must not run mutated tests"); };
  const result = await DRIVERS.V02(ctx);
  assert.equal(invoked, false);
  assert.equal(result.outcome, "fail");
  assert.equal(result.evidence.facts.independent, undefined);
});

test("missing print cleanup evidence blocks rather than reports a known leak", async t => {
  const { ctx } = context(t, "V02");
  const original = ctx.dependencies.runHeadless;
  ctx.dependencies.runHeadless = async options => {
    const result = await original(options); delete result.cleanup; return result;
  };
  const result = await DRIVERS.V02(ctx);
  assert.equal(result.outcome, "blocked", result.reason);
  assert.equal(result.safetyBreach, false);
  assert.equal(result.evidence.cleanup.ok, null);
});

test("driver retains confirmed defects when later native phases are missing", async t => {
  const { ctx } = context(t, "V01", (result, state) => {
    if (state.calls.includes("launch")) throw new Error("offline adapter failure");
    result.sdkRecords[0].servedModels = ["gpt-6-sol"];
  });
  const result = await DRIVERS.V01(ctx);
  assert.equal(result.outcome, "fail", result.reason);
  assert.equal(result.evidence.phases.clear.outcome, "blocked");
});

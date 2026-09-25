/** Saved-evidence false-pass regressions; no real CLI or provider calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluateStoredSlot, DRIVERS } from "../scripts/verify/drivers.mjs";
import { Checks, phaseVerdict, sameModel, toRun } from "../scripts/verify/evidence.mjs";
import { foregroundResult, tapReport, allowedSource, nativeInterruptionEvidence } from "../scripts/verify/scenario-checks.mjs";
import { HeadlessRun, sanitizeEnv, usageReport } from "../scripts/verify/session.mjs";
import { digest, snapshotTree } from "../scripts/verify/fixtures.mjs";
import { runProcess } from "../scripts/verify/process.mjs";
import { SCENARIO_IDS } from "../scripts/verify/scenarios.mjs";
import { makeSlot, tap, MODEL, toolResult, toolUse, assistant, returned } from "./fixtures/verify-evidence.mjs";

for (const id of SCENARIO_IDS) test(`${id} recomputes valid evidence as pass`, t => {
  const slot = makeSlot(t, id), out = evaluateStoredSlot(slot);
  assert.equal(out.outcome, "pass", out.reason);
  assert.ok(Object.values(out.evidence.phases).every(p => p.outcome === "pass" && p.checks.length));
  const saved = JSON.parse(JSON.stringify({ ...slot, ...out }));
  assert.equal(evaluateStoredSlot(saved).outcome, "pass");
});
test("V04 checks High on a supported target", t => {
  const out = evaluateStoredSlot(makeSlot(t, "V04", "claude-sonnet-5")); assert.equal(out.outcome, "pass", out.reason);
});

test("V05 accepts an exact fresh native interruption render without a transcript marker", t => {
  const slot = makeSlot(t, "V05"), f = slot.evidence.facts, interrupted = f.runs.interrupt;
  interrupted.events = [];
  interrupted.interruption.nativeReceipt = { kind: "render", screen: interrupted.interruption.screen,
    renderSequence: 11, outputSequence: 21, elapsedMs: f.testEscape.acknowledgedMs };
  const out = evaluateStoredSlot(slot);
  assert.equal(out.outcome, "pass", out.reason);
  assert.equal(evaluateStoredSlot(JSON.parse(JSON.stringify(slot))).outcome, "pass");
});

for (const [nativeId, normalizedId, expected] of [
  ["session-one", "session-one", true], [undefined, "session-one", true], ["session-one", undefined, true],
  ["other", "other", false], ["session-one", "other", false], ["other", "session-one", false],
  [undefined, undefined, false], [null, "session-one", false], ["", "session-one", false],
]) test(`interruption marker identities must match its run: ${nativeId}/${normalizedId}`, t => {
  const f = makeSlot(t, "V05").evidence.facts, run = f.runs.interrupt;
  const event = run.interruption.nativeReceipt.event;
  delete event.sessionId; delete event.session_id;
  if (nativeId !== undefined) event.sessionId = nativeId;
  if (normalizedId !== undefined) event.session_id = normalizedId;
  assert.equal(nativeInterruptionEvidence(run, f.testEscape), expected);
  assert.equal(evaluateStoredSlot({ model: MODEL, scenario: "V05", evidence: { facts: f } }).outcome, expected ? "pass" : "fail");
});

test("interruption evidence requires a known consistent run identity", t => {
  const f = makeSlot(t, "V05").evidence.facts, run = f.runs.interrupt;
  run.sessionId = "other";
  assert.equal(nativeInterruptionEvidence(run, f.testEscape), false);
  delete run.sessionId; delete run.observedSessionId;
  assert.equal(nativeInterruptionEvidence(run, f.testEscape), false);
});

const defects = [
  ["V05", "Boolean native receipt", f => { f.runs.interrupt.interruption.nativeReceipt = true; }],
  ["V05", "native output at acknowledged pre-write boundary", f => { f.runs.interrupt.interruption.nativeReceipt.outputSequence = f.testEscape.writeOutputSequence; }],
  ["V05", "native output between dispatch and actual write", f => { f.runs.interrupt.interruption.nativeReceipt.outputSequence = f.testEscape.writeOutputSequence - 1; }],
  ["V05", "missing acknowledged write boundary", f => { delete f.testEscape.writeOutputSequence; }],
  ["V05", "write boundary older than dispatched output", f => { f.testEscape.writeOutputSequence = f.testEscape.outputSequence - 1; }],
  ["V05", "wrong Escape sequence", f => { f.runs.interrupt.interruption.escapeSequence++; }],
  ["V05", "native receipt before input acknowledgment", f => { f.runs.interrupt.interruption.nativeReceipt.elapsedMs = f.testEscape.acknowledgedMs - 1; }],
  ["V05", "missing input acknowledgment time", f => { delete f.testEscape.acknowledgedMs; }],
  ["V05", "acknowledgment preceding input dispatch", f => { f.testEscape.acknowledgedMs = f.testEscape.elapsedMs - 1; }],
  ["V05", "wrong Escape byte count", f => { f.testEscape.byteCount = 2; }],
  ["V05", "fake interruption marker text", f => { f.runs.interrupt.interruption.nativeReceipt.event.message.content += " fake"; }],
  ["V05", "assistant interruption marker", f => { f.runs.interrupt.interruption.nativeReceipt.event.type = "assistant"; }],
  ["V05", "child interruption marker", f => { f.runs.interrupt.interruption.nativeReceipt.event.parent_tool_use_id = "agent-one"; }],
  ["V05", "sidechain interruption marker", f => { f.runs.interrupt.interruption.nativeReceipt.event.isSidechain = true; }],
  ["V05", "unready interruption screen despite ready claim", f => { f.runs.interrupt.interruption.screen = "Working (esc to interrupt)"; }],
  ["V05", "fake native render marker", f => { const r = f.runs.interrupt; r.events = [];
    r.interruption.nativeReceipt = { kind: "render", screen: "Interrupted\n❯", renderSequence: 11, outputSequence: 21, elapsedMs: 3 }; }],
  ["V05", "quoted native render marker", f => { const r = f.runs.interrupt; r.events = [];
    r.interruption.nativeReceipt = { kind: "render", screen: "Quote: ⎿ Interrupted · What should Claude do instead?\n❯", renderSequence: 11, outputSequence: 21, elapsedMs: 3 }; }],
  ["V01", "old conversation persists", f => { f.runs.clear.observedSessionId = "session-one"; }],
  ["V01", "clear leaks seed request", f => { f.runs.clear.observations.find(e => e.event === "bridge.verify_request").messageDigests.push({ textHashes: [f.seedHash] }); }],
  ["V01", "picker missing a model", f => { f.picker.models.pop(); }],
  ["V01", "wrong picker selection", f => { f.picker.current = "gpt-6-sol"; }],
  ["V01", "answer with extra prose", f => { f.runs.unicode.events[0].message.content[0].text += "\nDone"; }],
  ["V01", "appended sentence punctuation", f => { f.runs.unicode.events[0].message.content[0].text += "."; }],
  ["V01", "quoted literal", f => { const b = f.runs.unicode.events[0].message.content[0]; b.text = `"${b.text}"`; }],
  ["V01", "smart-quoted literal", f => { const b = f.runs.unicode.events[0].message.content[0]; b.text = `“${b.text}”`; }],
  ["V01", "decomposed Unicode", f => { const b = f.runs.unicode.events[0].message.content[0]; b.text = b.text.normalize("NFD"); }],
  ["V01", "changed accented character", f => { const b = f.runs.unicode.events[0].message.content[0]; b.text = b.text.replace("café", "cafe"); }],
  ["V01", "changed Korean character", f => { const b = f.runs.unicode.events[0].message.content[0]; b.text = b.text.replace("안녕", "안영"); }],
  ["V02", "failed Read", f => { toolResult(f.runs.coding, "read-sample.txt").is_error = true; }],
  ["V02", "partial Read", f => { toolResult(f.runs.coding, "read-discount.mjs").content = "export"; }],
  ["V02", "source path mismatch", f => { toolUse(f.runs.coding, "read-discount.mjs").input.file_path = "other.mjs"; }],
  ["V02", "masked initial failure", f => { toolResult(f.runs.coding, "initial").is_error = false; }],
  ["V02", "initial rendered exit zero", f => { toolResult(f.runs.coding, "initial").content = toolResult(f.runs.coding, "initial").content.replace("Exit code 1", "Exit code 0"); }],
  ["V02", "initial rendered unrelated exit", f => { toolResult(f.runs.coding, "initial").content = toolResult(f.runs.coding, "initial").content.replace("Exit code 1", "Exit code 2"); }],
  ["V02", "hidden retest failure", f => { toolResult(f.runs.coding, "retest").content = "Exit code 1\n" + tap(f.fixture); }],
  ["V02", "chained test", f => { toolUse(f.runs.coding, "initial").input.command += " || true"; }],
  ["V02", "redirected test", f => { toolUse(f.runs.coding, "initial").input.command += " > result.txt"; }],
  ["V02", "background test", f => { toolUse(f.runs.coding, "initial").input.run_in_background = true; }],
  ["V02", "summary-only output", f => { toolResult(f.runs.coding, "retest").content = "# pass 3\n# fail 0"; }],
  ["V02", "failed Edit despite fixed source", f => { toolResult(f.runs.coding, "edit").is_error = true; }],
  ["V02", "retest precedes Edit", f => { const e = f.runs.coding.events.find(e => e.message?.id === "retest"); f.runs.coding.events.splice(f.runs.coding.events.indexOf(e), 1); f.runs.coding.events.splice(1, 0, e); }],
  ["V02", "changed test file", f => { f.after.entries[f.fixture.testFile].sha256 = "e".repeat(64); }],
  ["V02", "extra workspace file", f => { f.after.entries["recall.txt"] = { type: "file", mode: 384, sha256: "f".repeat(64) }; }],
  ["V02", "source symlink", f => { f.after.entries[f.fixture.sourceFile].type = "symlink"; }],
  ["V02", "independent process failure", f => { f.independent.completed = false; f.independent.status = 1; }],
  ["V02", "crash after success envelope", f => { f.runs.coding.exitCode = 2; }],
  ["V02", "duplicate result envelope", f => { f.runs.coding.events.push(structuredClone(f.runs.coding.events.at(-1))); }],
  ["V02", "permission denial", f => { f.runs.coding.events.at(-1).permission_denials = [{}]; }],
  ["V02", "negative usage", f => { f.runs.coding.events.at(-1).usage.input_tokens = -1; }],
  ["V03", "MCP bypass via Read", f => { toolUse(f.runs.lookup, "missing").name = "Read"; }],
  ["V03", "wrong MCP arguments", f => { toolUse(f.runs.lookup, "missing").input.key = "selected"; }],
  ["V03", "MCP no error", f => { toolResult(f.runs.lookup, "missing").is_error = false; }],
  ["V03", "MCP ledger wrong value", f => { f.mcpLedger.at(-1).result.content[0].text = "wrong"; }],
  ["V03", "MCP duplicate response", f => { f.mcpLedger.push(structuredClone(f.mcpLedger.at(-1))); }],
  ["V03", "second process recall", f => { f.runs.recall.pid++; }],
  ["V03", "recall uses tool", f => { f.runs.recall.events.unshift(assistant("extra", [{ type: "tool_use", id: "extra", name: "mcp__fixture__lookup", input: { key: "selected" } }]), returned("extra", "value")); }],
  ["V04", "unchanged model after switch", f => { f.runs.target.sdkRecords[0].servedModels = ["gpt-6-sol"]; }],
  ["V04", "lost source context", f => { f.runs.target.observations.filter(e => e.event === "bridge.verify_request").forEach(e => { e.userTextHashes = []; }); }],
  ["V04", "Haiku effort applied", f => { f.runs.target.observations.find(e => e.event === "bridge.verify_model_state").appliedEffort = "high"; }],
  ["V05", "Escape after completion", f => { f.beforeEscape.push({ event: "bridge.turn_completed", requestId: f.interruptRequestId, responseId: "interrupted-response" }); }],
  ["V05", "unacknowledged abort", f => { f.runs.interrupt.observations.find(e => e.event === "bridge.turn_abort_completed").acknowledged = false; }],
  ["V05", "normally completed interrupted request", f => { f.runs.interrupt.observations.push({ event: "bridge.turn_completed", requestId: f.interruptRequestId, responseId: "interrupted-response" }); }],
  ["V05", "different recovery process", f => { f.runs.recovery.pid++; }],
  ["V05", "reasoning-only progress", f => { f.beforeEscape[1].kind = "assistant.reasoning_delta"; }],
  ["V05", "progress from another response", f => { f.beforeEscape[1].responseId = "other-response"; }],
  ["V05", "progress before its request", f => { f.beforeEscape.reverse(); f.runs.interrupt.observations.splice(0, 2, ...f.beforeEscape); }],
  ["V05", "subagent request", f => { f.beforeEscape[0].claudeAgent = "subagent"; }],
  ["V05", "unrelated session request", f => { f.beforeEscape[0].claudeSessionId = "other-session"; }],
  ["V05", "abort predating Escape", f => { f.beforeEscape.push(f.runs.interrupt.observations[2]); }],
  ["V05", "ack before abort", f => { const rows = f.runs.interrupt.observations; [rows[2], rows[3]] = [rows[3], rows[2]]; }],
  ["V05", "changed prior log", f => { f.beforeEscape = structuredClone(f.beforeEscape); f.beforeEscape[0].extra = "not in full log"; }],
  ["V05", "native already ready before Escape", f => { f.nativeBeforeEscape.ready = true; }],
  ["V05", "unaccepted native receipt", f => { f.testEscape.accepted = false; }],
  ["V05", "cleanup receipt as test Escape", f => { f.testEscape.purpose = "cleanup"; }],
  ["V05", "Escape receipt without actual native evidence", f => { f.runs.interrupt.interruption.nativeReceipt = false; f.runs.interrupt.events = []; }],
  ["V05", "claimed interruption without marker", f => { f.runs.interrupt.events = []; }],
  ["V05", "old native interruption render", f => { f.runs.interrupt.interruption.renderSequence = f.testEscape.renderSequence; }],
  ["V05", "native not ready for recovery", f => { f.nativeAfterInterrupt.ready = false; }],
  ["V05", "cancelled pending observer", f => { f.interruptTiming.observerCancelled = true; }],
  ["V05", "abort after settle deadline", f => { f.interruptTiming.ackAt = f.interruptTiming.settleDeadline + 1; }],
  ["V05", "observer after settle deadline", f => { f.interruptTiming.settledAt = f.interruptTiming.settleDeadline + 1; }],
  ["V05", "recovery preceding SDK acknowledgment", f => { f.interruptTiming.recoveryStartedAt = f.interruptTiming.ackAt - 1; }],
  ["V05", "recovery consuming cleanup reserve", f => { f.interruptTiming.recoveryTurnDeadline = f.interruptTiming.slotDeadline; }],
  ["V06", "automatic instead of manual compact", f => { f.runs.compact.events[0].compactMetadata.trigger = "auto"; }],
  ["V06", "wrong resumed session", f => { f.runs.resume.observedSessionId = "other-session"; }],
  ["V06", "same process called resume", f => { f.runs.resume.pid = f.runs.seed.pid; }],
  ["V06", "same bridge reused", f => { f.restart.afterPid = f.restart.beforePid; }],
  ["V06", "unclean first exit", f => { f.launches[0].exitCode = 1; }],
  ["V06", "nonce in followup", f => { f.followupPrompts[1] += f.recallValue; }],
  ["V06", "unlinked compact history", f => { f.resumedHistory = []; }],
  ["V06", "stale SDK session reused after compact", f => { for (const o of f.runs.recall.observations) if (o.event === "bridge.verify_model_state") o.sessionId = sdkSession(f.runs.seed); }],
  ["V06", "summary SDK session reused after compact", f => {
    const summary = sdkSession(f.runs.compact);
    for (const o of f.runs.seed.observations) if (o.event === "bridge.verify_model_state") o.sessionId = "sdk-seed-only";
    for (const o of f.runs.recall.observations) if (o.event === "bridge.verify_model_state") o.sessionId = summary;
  }],
  ["V06", "uncompacted seed sent after compact", f => { for (const o of f.runs.recall.observations) if (o.event === "bridge.verify_request") o.userTextHashes = [f.seedHash]; }],
  ["V06", "seed prompt never sent", f => { for (const o of f.runs.seed.observations) if (o.event === "bridge.verify_request") o.userTextHashes = []; }],
];
function sdkSession(run) { return run.observations.find(o => o.event === "bridge.verify_model_state").sessionId; }
for (const [id, name, mutate] of defects) test(`${id} rejects ${name}`, t => {
  const slot = makeSlot(t, id); mutate(slot.evidence.facts);
  const out = evaluateStoredSlot({ ...slot, outcome: "pass" });
  assert.equal(out.outcome, "fail", out.reason);
});

for (const [name, mutate] of [
  ["missing phase", f => { delete f.runs.print; }],
  ["missing SDK completion", f => { f.runs.print.sdkRecords = []; }],
  ["missing SDK model ID", f => { f.runs.print.sdkRecords[0].servedModels = []; }],
  ["missing transport", f => { f.runs.print.observations = f.runs.print.observations.filter(e => e.event !== "bridge.verify_response"); }],
]) test(`missing evidence never passes: ${name}`, t => {
  const slot = makeSlot(t); mutate(slot.evidence.facts); assert.notEqual(evaluateStoredSlot(slot).outcome, "pass");
});
for (const [name, mutate] of [
  ["duplicate result ID", r => { r.events.push(structuredClone(r.events.find(e => e.message?.content?.[0]?.type === "tool_result"))); }],
  ["orphan result", r => { r.events.splice(2, 0, returned("orphan", "ok")); }],
  ["wrong request session", r => { r.observations.find(e => e.event === "bridge.verify_request").claudeSessionId = "unrelated-session"; }],
  ["wrong served model plus correct side traffic", r => { r.sdkRecords.push({ ...r.sdkRecords[0], responseId: "unrelated" }); r.sdkRecords[0].servedModels = ["gpt-6-sol"]; }],
  ["substring model", r => { r.sdkRecords[0].servedModels = [`extra-${MODEL}`]; }],
  ["mixed served models", r => { r.sdkRecords[0].servedModels.push("gpt-6-sol"); }],
  ["duplicate completion", r => { r.sdkRecords.push(structuredClone(r.sdkRecords[0])); }],
  ["bad JSON", r => { r.parseErrors = 1; }],
  ["external plugin", r => { r.events[0].plugins = [{ name: "agents-md", path: "/external" }]; }],
  ["hook event", r => { r.events.splice(1, 0, { type: "system", subtype: "hook_started" }); }],
  ["child actor", r => { r.events[1].parent_tool_use_id = "agent-1"; }],
]) test(`common gate rejects ${name}`, t => {
  const slot = makeSlot(t, "V02"); mutate(slot.evidence.facts.runs.coding);
  assert.notEqual(evaluateStoredSlot(slot).outcome, "pass");
});

for (const [id, name, change] of [
  ["V03", "different recall target", f => { f.answers.recall = digest("wrong"); f.runs.recall.events[0].message.content[0].text = "wrong"; }],
  ["V06", "different resume target", f => { f.answers.resume = digest("wrong"); f.runs.resume.events[0].message.content[0].text = "wrong"; }],
  ["V05", "corrupt interrupted transcript", f => { f.runs.interrupt.parseErrors = 1; }],
  ["V06", "corrupt compact transcript", f => { f.runs.compact.parseErrors = 1; }],
]) test(`${id} rejects ${name}`, t => {
  const slot = makeSlot(t, id); change(slot.evidence.facts);
  assert.equal(evaluateStoredSlot(slot).outcome, "fail");
});
for (const [name, mutate] of [
  ["unreported recall SDK session", f => { for (const o of f.runs.recall.observations) if (o.event === "bridge.verify_model_state") o.sessionId = null; }],
  ["no seed SDK session", f => { f.runs.seed.observations = f.runs.seed.observations.filter(o => o.event !== "bridge.verify_model_state"); f.runs.compact.observations = f.runs.compact.observations.filter(o => o.event !== "bridge.verify_model_state"); }],
  ["unrecorded recall history", f => { for (const o of f.runs.recall.observations) if (o.event === "bridge.verify_request") delete o.userTextHashes; }],
  ["unrecorded seed digest", f => { delete f.seedHash; }],
]) test(`V06 compaction handoff blocks on ${name}`, t => {
  const slot = makeSlot(t, "V06"); mutate(slot.evidence.facts);
  const out = evaluateStoredSlot(slot), handoff = out.checks.filter(c => /^(?:fresh SDK session|compacted history sent) after compact$/.test(c.name));
  assert.equal(handoff.length, 2);
  assert.ok(handoff.some(c => c.outcome === "blocked") && handoff.every(c => c.outcome !== "fail"), JSON.stringify(handoff));
});
test("V06 accepts the stored bridge pattern: seed and summary share an SDK session, recall and resume each get a new one", t => {
  const f = makeSlot(t, "V06").evidence.facts;
  assert.equal(sdkSession(f.runs.seed), sdkSession(f.runs.compact));
  assert.equal(new Set(["seed", "recall", "resume"].map(p => sdkSession(f.runs[p]))).size, 3);
  const out = evaluateStoredSlot({ model: MODEL, scenario: "V06", evidence: { facts: f } });
  assert.equal(out.outcome, "pass", out.reason);
  assert.ok(out.checks.some(c => c.name === "fresh SDK session after compact" && c.ok));
  assert.ok(out.checks.some(c => c.name === "compacted history sent after compact" && c.ok));
});
test("missing expected answer never disables exact-answer validation", t => {
  const slot = makeSlot(t); delete slot.evidence.facts.answers.unicode;
  assert.equal(evaluateStoredSlot(slot).outcome, "blocked");
});

test("a known SDK defect outranks a missing companion field", t => {
  for (const missing of ["stopReason", "toolUses"]) {
    const slot = makeSlot(t, "V02"), row = slot.evidence.facts.runs.coding.sdkRecords[0];
    row.stopReason = "refusal"; row.toolUses = 999; delete row[missing];
    assert.equal(evaluateStoredSlot(slot).outcome, "fail");
  }
});
test("missing SDK counters remain blocked instead of inventing zero activity", t => {
  const slot = makeSlot(t, "V02");
  delete slot.evidence.facts.runs.coding.sdkRecords[0].inputTokens;
  assert.equal(evaluateStoredSlot(slot).outcome, "blocked");
});
test("finite individual SDK counters cannot overflow phase totals", t => {
  const slot = makeSlot(t, "V02");
  slot.evidence.facts.runs.coding.sdkRecords.forEach(row => { row.inputTokens = 1e308; });
  assert.equal(evaluateStoredSlot(slot).outcome, "fail");
});

test("native launcher claims alone cannot establish isolation", t => {
  const slot = makeSlot(t); slot.evidence.facts.runs.unicode.launchPolicy = { isolated: true, tools: [], mcpServers: [] };
  assert.equal(evaluateStoredSlot(slot).outcome, "fail");
});
test("known failure outranks missing evidence", t => {
  const slot = makeSlot(t, "V02"); slot.evidence.facts.runs.coding.sdkRecords = [];
  toolResult(slot.evidence.facts.runs.coding, "edit").is_error = true;
  assert.equal(evaluateStoredSlot(slot).outcome, "fail");
});
test("blocked or absent saved facts cannot be relabeled pass", () => {
  assert.equal(evaluateStoredSlot({ outcome: "pass", model: MODEL, scenario: "V01" }).outcome, "blocked");
});
test("TAP handles real failing and fixed fixture without environment reporter leakage", async t => {
  const slot = makeSlot(t, "V02"), f = slot.evidence.facts;
  const first = await runProcess(process.execPath, f.fixture.testCommand.slice(1), { cwd: f.workspace, env: sanitizeEnv(), timeoutMs: 5000 });
  assert.equal(first.status, 1); assert.equal(tapReport(first.stdout, f.fixture, true).ok, true, first.stdout);
  fs.writeFileSync(path.join(f.workspace, f.fixture.sourceFile), f.fixture.fixedSource);
  const fixed = await runProcess(process.execPath, f.fixture.testCommand.slice(1), { cwd: f.workspace, env: sanitizeEnv(), timeoutMs: 5000 });
  assert.equal(fixed.status, 0); assert.equal(tapReport(fixed.stdout, f.fixture).ok, true, fixed.stdout);
  assert.equal(tapReport(fixed.stdout, f.fixture, true).ok, false);
  assert.equal(tapReport(fixed.stdout + fixed.stdout, f.fixture).ok, false);
});
test("foreground results allow absent numeric fields but enforce error and rendered status", () => {
  assert.equal(foregroundResult({ isError: true, content: "Exit code 1\nTAP" }, 1), true);
  assert.equal(foregroundResult({ isError: false, content: "TAP" }, 0), true);
  assert.equal(foregroundResult({ isError: true, content: "Exit code 0\nTAP" }, 1), false);
});
test("usage rejects nonfinite, negative and overflowing totals", () => {
  for (const v of [NaN, Infinity, -1, "100", null]) assert.equal(usageReport({ input_tokens: v, output_tokens: 1 }).ok, false);
  assert.equal(usageReport({ input_tokens: 1e308, output_tokens: 1, cache_read_input_tokens: 1e308 }).ok, false);
  assert.equal(usageReport({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 100 }).ok, true);
});
test("model normalization uses full IDs, never substring or family fallback", () => {
  assert.equal(sameModel("claude-haiku-4-5[1m]", MODEL), true);
  assert.equal(sameModel(`extra-${MODEL}`, MODEL), false);
});
test("native adapter getter fields never override parsed answers", () => {
  const r = toRun({ answer: "forged", sessionId: "s", completed: true, events: [assistant("id", "real")] });
  assert.equal(r.answer, "real"); assert.equal(r.observedSessionId, "s"); assert.equal(r.completed, false);
});
test("source edits keep unrelated bytes and snapshots never follow links", t => {
  const slot = makeSlot(t, "V02"), f = slot.evidence.facts;
  assert.equal(allowedSource(f.fixture.fixedSource.replaceAll("\n", "\r\n"), f.fixture), false);
  fs.symlinkSync("/missing-target", path.join(f.workspace, "outside"));
  assert.equal(snapshotTree(f.workspace).entries.outside.type, "symlink");
});
test("child environment drops inherited injection and provider settings", () => {
  const clean = sanitizeEnv({ PATH: "/safe/bin", GH_TOKEN: "kept", ANTHROPIC_API_KEY: "drop", CLAUDECODE: "drop", BRIDGE_TEST_FAULTS: "drop", BRIDGE_LEASE_DIR: "drop", NODE_TEST_CONTEXT: "child-v8", NODE_OPTIONS: "--require injected.cjs" });
  assert.deepEqual(clean, { PATH: "/safe/bin", GH_TOKEN: "kept" });
});

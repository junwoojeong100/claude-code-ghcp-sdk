/** Synthetic native/bridge evidence. Never used by the live driver. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixture, digest, snapshotTree } from "../../scripts/verify/fixtures.mjs";
import { SCENARIOS, PRIMARY_MODELS, phaseModel } from "../../scripts/verify/scenarios.mjs";
import { launchModelFor } from "../../src/model-map.mjs";
export const MODEL = "claude-haiku-4.5";
export const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
export const assistant = (id, content, session = "session-one") => ({ type: "assistant", session_id: session, parent_tool_use_id: null,
  message: { id, role: "assistant", content: Array.isArray(content) ? content : [{ type: "text", text: content }], stop_reason: null } });
export const returned = (id, content, metadata, is_error = false) => ({ type: "user", session_id: "session-one", parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, tool_use_result: metadata });
export function tap(fixture, initial = false) {
  const failures = initial ? fixture.initialFailures : [];
  return "TAP version 13\n" + fixture.testNames.map((name, i) => `${failures.includes(name) ? "not ok" : "ok"} ${i + 1} - ${name}\n`).join("") +
    `1..${fixture.testNames.length}\n# tests ${fixture.testNames.length}\n# pass ${fixture.testNames.length - failures.length}\n# fail ${failures.length}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}
export function nativePolicy(root, tools = [], mcpServers = []) {
  return { args: ["--settings", `${root}/native-settings.json`, "--setting-sources", "", "--strict-mcp-config", "--no-chrome", "--permission-mode", "dontAsk", "--tools", tools.join(",")],
    home: `${root}/home`, configDir: `${root}/config`, workspace: `${root}/workspace`, tmpDir: `${root}/tmp`,
    settingsSha256: "a".repeat(64), isolationSettingsSha256: "b".repeat(64), isolationSettingsPath: `${root}/native-settings.json`,
    settings: { disableAllHooks: true, autoMemoryEnabled: false, enableAllProjectMcpServers: false, enabledPlugins: {} }, tools, mcpServers };
}
export function logs(events, model = MODEL, { hashes = [], effort = null, session = "session-one", sdkSession = `sdk-${model}` } = {}) {
  const messages = new Map();
  for (const e of events) if (e.type === "assistant") messages.set(e.message.id, e.message);
  return [...messages.values()].flatMap(m => {
    const requestId = `request-${m.id}`, responseId = m.id, toolUses = m.content.filter(c => c.type === "tool_use").length;
    return [
      { event: "bridge.verify_request", requestId, responseId, requestedModel: model, claudeSessionId: session, claudeAgent: "root", streaming: true, userTextHashes: hashes, messageDigests: hashes.map(h => ({ role: "user", textHashes: [h], sha256: h })) },
      { event: "bridge.verify_model_state", requestId, responseId, sessionId: sdkSession, model, ok: true, requestedEffort: effort, appliedEffort: effort, requestedContextTier: "long_context", current: { modelId: model, reasoningEffort: effort, contextTier: "long_context" } },
      { event: "bridge.verify_response", requestId, responseId, status: 200, streaming: true, finished: true, aborted: false },
      { event: "bridge.turn_completed", requestId, responseId, requestedModel: model, model, servedModels: [model], claudeAgent: "root", usageReported: true, inputTokens: 100, outputTokens: 10, stopReason: toolUses ? "tool_use" : "end_turn", toolUses },
    ];
  });
}
export function run(events, { model = MODEL, root = "/synthetic", native = true, tools = [], hashes = [], effort = null, session = "session-one", pid = 101, sdkSession } = {}) {
  const observations = logs(events, model, { hashes, effort, session, sdkSession });
  const result = { events, observations, sdkRecords: observations.filter(e => e.event === "bridge.turn_completed"),
    sdkLogRange: { path: `${root}/bridge.log`, start: 0, end: 100 }, sdkLogError: null, nativeTurn: native, observedSessionId: session,
    pid, transcriptPath: `${root}/transcript.jsonl`, exitCode: native ? null : 0, signal: null, parseErrors: 0 };
  if (native) result.launchPolicy = nativePolicy(root, tools, tools.includes("mcp__fixture__lookup") ? ["fixture"] : []);
  else result.events = [{ type: "system", subtype: "init", tools, plugins: [], skills: [], mcp_servers: [], session_id: session }, ...events,
    { type: "result", subtype: "success", is_error: false, session_id: session, usage: { input_tokens: 100, output_tokens: 10 } }];
  return result;
}
export function compactRun({ root = "/synthetic", model = MODEL, session = "session-one", pid = 101, sdkSession } = {}) {
  const transcriptPath = `${root}/${session}.jsonl`, text = "Summary:\nSynthetic conversation summary.";
  const boundary = { type: "system", subtype: "compact_boundary", sessionId: session, session_id: session,
    compactMetadata: { trigger: "manual" }, uuid: "boundary-1" };
  const summary = { type: "user", isCompactSummary: true, uuid: "summary-1", parentUuid: boundary.uuid,
    sessionId: session, session_id: session, message: { role: "user", content:
      `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${text}\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}\nContinue the conversation.` } };
  const result = run([boundary, summary], { root, model, session, pid });
  result.transcriptPath = transcriptPath;
  result.observations = logs([assistant("summary-response", text, session)], model, { session, sdkSession });
  result.observations.find(r => r.event === "bridge.verify_request").compactRequested = true;
  result.sdkRecords = result.observations.filter(r => r.event === "bridge.turn_completed");
  result.sdkRecords[0].compactSummarySha256 = digest(text);
  return result;
}

export function makeSlot(t, id = "V01", model = MODEL) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-facts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), fixture = buildFixture(id, workspace), before = snapshotTree(workspace);
  const seed = "remember synthetic nonce", value = "SYNTHETIC_NONCE";
  const facts = { workspace, fixture, preflight: { plugins: [] }, before, after: structuredClone(before), runs: {}, answers: {},
    launches: [{ ok: true, exitCode: 0, pid: 101, groupGone: true }], isolation: { ok: true }, settings: { ok: true },
    commands: [], seedHash: digest(seed) };
  for (const { id: phase } of SCENARIOS.find(s => s.id === id).phases) {
    const answer = `${id}-${phase}-answer`;
    facts.answers[phase] = digest(answer);
    facts.runs[phase] = run([assistant(`${id}-${phase}`, answer)], { root, model: phaseModel({ id }, phase, model), hashes: [facts.seedHash],
      native: !(phase === "print" || phase === "coding"), tools: id === "V03" ? ["mcp__fixture__lookup"] : [], effort: id === "V04" && phase === "target" && model !== MODEL ? "high" : null });
  }
  if (id === "V01") {
    const unicode = "VERIFY_a0b1 안녕 café";
    facts.runs.unicode.events[0].message.content[0].text = unicode;
    facts.answers.unicode = digest(unicode);
    facts.picker = { models: [...PRIMARY_MODELS], current: model };
    facts.runs.clear.observedSessionId = "session-two";
    facts.runs.clear.events.forEach(e => { e.session_id = "session-two"; });
    facts.runs.clear.observations.filter(e => e.event === "bridge.verify_request").forEach(e => { e.claudeSessionId = "session-two"; e.userTextHashes = []; e.messageDigests = []; });
    facts.launches.push({ ok: true, exitCode: 0, pid: 102, groupGone: true });
  } else if (id === "V02") {
    const f = fixture, content = [];
    for (const [file, text] of [[f.sourceFile, f.source], [f.testFile, f.tests], [f.sampleFile, f.sample + "\n"]]) {
      const tid = `read-${file}`;
      content.push(assistant(tid, [tool(tid, "Read", { file_path: path.join(workspace, file) })]), returned(tid, text));
    }
    content.push(assistant("initial", [tool("initial", "Bash", { command: f.testCommand.join(" ") })]), returned("initial", `Exit code 1\n${tap(f, true)}`, undefined, true),
      assistant("edit", [tool("edit", "Edit", { file_path: path.join(workspace, f.sourceFile), old_string: f.source, new_string: f.fixedSource })]), returned("edit", "The file has been updated successfully."),
      assistant("retest", [tool("retest", "Bash", { command: f.testCommand.join(" ") })]), returned("retest", tap(f)), assistant("final", f.sample));
    facts.runs.coding = run(content, { root, model, native: false, tools: ["Read", "Edit", "Bash"] });
    facts.answers.coding = digest(f.sample); facts.source = f.fixedSource;
    facts.after.entries[f.sourceFile].sha256 = digest(f.fixedSource);
    facts.independent = { completed: true, status: 0, signal: null, stdout: tap(f), stderr: "", timedOut: false, aborted: false };
  } else if (id === "V03") {
    const content = [assistant("missing", [tool("missing", "mcp__fixture__lookup", { key: "missing" })]), returned("missing", "ENOENT", undefined, true),
      assistant("selected", [tool("selected", "mcp__fixture__lookup", { key: "selected" })]), returned("selected", value), assistant("lookup-final", value)];
    facts.runs.lookup = run(content, { root, model, tools: ["mcp__fixture__lookup"] });
    facts.runs.recall = run([assistant("recall-final", value)], { root, model, tools: ["mcp__fixture__lookup"] });
    facts.answers.lookup = facts.answers.recall = digest(value);
    facts.mcpLedger = ["missing", "selected"].flatMap((key, i) => [
      { event: "request", method: "tools/call", id: i + 1, params: { name: "lookup", arguments: { key } } },
      { event: "response", method: "tools/call", id: i + 1, result: { isError: i === 0, content: [{ type: "text", text: i === 0 ? "ENOENT" : value }] } },
    ]);
  } else if (id === "V04") {
    facts.commands = [{ text: `/model ${launchModelFor(model)}` }, ...(model === MODEL ? [] : [{ text: "/effort high" }])];
  } else if (id === "V05") {
    const requestId = "interrupted-request", responseId = "interrupted-response";
    facts.interruptRequestId = requestId;
    facts.beforeEscape = [
      { event: "bridge.verify_request", requestId, responseId, requestedModel: model, streaming: true, claudeSessionId: "session-one", claudeAgent: "root" },
      { event: "bridge.verify_progress", requestId, responseId, kind: "assistant.message_delta" },
    ];
    const screen = "⎿ Interrupted · What should Claude do instead?\n❯";
    facts.nativeBeforeEscape = { active: true, interruptible: true, ready: false, renderSequence: 10, outputSequence: 18, screen: "Working (esc to interrupt)" };
    facts.testEscape = { kind: "escape", purpose: "test-interrupt", sequence: 1, renderSequence: 10, outputSequence: 18,
      writeOutputSequence: 20, elapsedMs: 1, acknowledgedMs: 2, accepted: true, byteCount: 1 };
    facts.nativeAfterInterrupt = { active: false, interruptible: false, ready: true, renderSequence: 11, outputSequence: 21, screen };
    facts.interruptTiming = { budgets: { progressMs: 90000, settleMs: 15000, recoveryMs: 60000, cleanupMs: 10000 },
      startedAt: 1000, slotDeadline: 241000, interruptDeadline: 171000, recoveryDeadline: 231000, progressDeadline: 91000,
      escapeAt: 2000, settleDeadline: 17000, settledAt: 2050, readyAt: 2050, ackAt: 2100,
      recoveryStartedAt: 2150, recoveryTurnDeadline: 62150, recoverySettledAt: 3000 };
    facts.interruptOutcome = "interrupted";
    const event = { type: "user", session_id: "session-one", parent_tool_use_id: null, message: { role: "user", content: "[Request interrupted by user]" } };
    facts.runs.interrupt = run([event], { root, model });
    Object.assign(facts.runs.interrupt, { screen, interrupted: true, interruption: { escapeSequence: facts.testEscape.sequence,
      nativeReceipt: { kind: "event", event, renderSequence: 11, outputSequence: 21, elapsedMs: 3 },
      ready: true, screen, renderSequence: 11, outputSequence: 21 } });
    facts.runs.interrupt.observations = [...facts.beforeEscape,
      { event: "bridge.turn_aborted", requestId, responseId, reason: "client_abort" },
      { event: "bridge.turn_abort_completed", requestId, responseId, reason: "client_abort", acknowledged: true },
      { event: "bridge.verify_response", requestId, responseId, aborted: true, finished: false }];
  } else if (id === "V06") {
    facts.runs.compact = compactRun({ root, model });
    facts.resumedHistory = structuredClone(facts.runs.compact.events); facts.recallValue = value;
    // Like the bridge: seed and summary share one SDK session; the compacted
    // recall and the restarted bridge's resume each get a fresh one.
    for (const phase of ["recall", "resume"]) {
      facts.runs[phase].events[0].message.content[0].text = value;
      facts.answers[phase] = digest(value);
      for (const r of facts.runs[phase].observations) {
        if (r.event === "bridge.verify_model_state") r.sessionId = `sdk-${model}-${phase}`;
        if (r.event === "bridge.verify_request") { r.userTextHashes = []; r.messageDigests = []; }
      }
    }
    facts.followupPrompts = ["Recall the value", "Recall the value"];
    facts.restart = { beforePid: 201, afterPid: 202, cleanup: { ok: true } };
    facts.runs.resume.pid = 102; facts.launches.push({ ok: true, exitCode: 0, pid: 102, groupGone: true });
  }
  return { model, scenario: id, evidence: { facts } };
}
export function toolResult(phase, id) { return phase.events.flatMap(e => e.message?.content ?? []).find(c => c.type === "tool_result" && c.tool_use_id === id); }
export function toolUse(phase, id) { return phase.events.flatMap(e => e.message?.content ?? []).find(c => c.type === "tool_use" && c.id === id); }

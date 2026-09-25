/** Scenario predicates consume saved facts; none executes a model or modifies files. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Checks, sameModel, toRun, isolationChecks, numeric } from "./evidence.mjs";
import { digest } from "./fixtures.mjs";
import { terminalActivity, interruptionLines } from "./native-dialogs.mjs";

const samePath = (actual, relative, workspace) => typeof actual === "string" && path.resolve(workspace, actual) === path.resolve(workspace, relative);
const lines = text => String(text).replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
export const sessionId = run => run?.observedSessionId ?? run?.sessionId ?? null;
export const returned = (run, use) => {
  const matches = run.toolResults.filter(r => r.id === use?.id);
  return matches.length === 1 ? matches[0] : null;
};
export function fullRead(result, original, relative, workspace) {
  if (!result || result.isError) return false;
  if (result.metadata && typeof result.metadata === "object") {
    const m = result.metadata, f = m.file;
    return m.type === "text" && samePath(f?.filePath, relative, workspace) && f.startLine === 1 &&
      f.numLines === f.totalLines && f.numLines > 0 && !f.truncatedByTokenCap && isDeepStrictEqual(lines(f.content), lines(original));
  }
  if (result.content === original || result.content === original.replace(/\n$/, "")) return true;
  const numbered = result.content.split("\n").map(l => /^\s*(\d+)(?:→|\t)(.*)$/.exec(l)).filter(Boolean);
  return numbered.length === lines(original).length && numbered.every((m, i) => Number(m[1]) === i + 1 && m[2] === lines(original)[i]);
}
export function foregroundResult(result, expectedExit) {
  if (!result || result.isError !== (expectedExit !== 0)) return false;
  const m = result.metadata;
  if (m && (m.interrupted || m.backgroundTaskId || m.backgroundedByUser || m.timedOutAfterMs || m.dangerouslyDisableSandbox)) return false;
  for (const key of ["exitCode", "exit_code"]) if (m?.[key] != null && m[key] !== expectedExit) return false;
  for (const match of result.content.matchAll(/^Exit code (-?\d+)\s*$/gm)) if (Number(match[1]) !== expectedExit) return false;
  return !/background task|running in (?:the )?background|timed out|interrupted/i.test(result.content);
}
export function tapReport(text, fixture, initial = false) {
  const rows = String(text ?? "").replaceAll("\r", "").split("\n"), names = fixture.testNames;
  const failures = initial ? fixture.initialFailures : [], count = names.length, counters = {};
  const results = rows.map(l => /^(not ok|ok) (\d+) - (.+)$/.exec(l)).filter(Boolean);
  let ok = rows.filter(l => l === "TAP version 13").length === 1 && rows.filter(l => l === `1..${count}`).length === 1 && !rows.some(l => /^Bail out!/i.test(l));
  for (const [key, expected] of Object.entries({ tests: count, pass: count - failures.length, fail: failures.length, cancelled: 0, skipped: 0, todo: 0 })) {
    const matches = rows.map(l => new RegExp(`^# ${key} (\\d+)$`).exec(l)).filter(Boolean);
    counters[key] = matches.length === 1 ? Number(matches[0][1]) : null;
    ok &&= counters[key] === expected;
  }
  ok &&= results.length === count && results.every((m, i) => Number(m[2]) === i + 1 && m[3] === names[i] && m[1] === (failures.includes(m[3]) ? "not ok" : "ok"));
  return { ok, counters, results: results.map(m => ({ name: m[3], ok: m[1] === "ok" })) };
}
export function allowedSource(source, fixture) {
  if (typeof source !== "string") return false;
  const before = fixture.source.split("\n"), after = source.split("\n");
  if (after.length !== before.length || before.some((line, i) => i !== 1 && line !== after[i])) return false;
  return new Set(["returnprice*(100-percent)/100;", "return(price*(100-percent))/100;", "returnprice*((100-percent)/100);", "returnprice*(1-percent/100);"]).has(after[1].replace(/\s/g, ""));
}
export function codingChecks(run, { fixture, workspace }, checks = new Checks()) {
  const uses = run.toolUses, bash = uses.filter(u => u.name === "Bash"), edits = uses.filter(u => u.name === "Edit");
  const [first, retest] = bash, [edit] = edits, initialResult = returned(run, first), editResult = returned(run, edit), retestResult = returned(run, retest);
  const files = [[fixture.sourceFile, fixture.source], [fixture.testFile, fixture.tests], [fixture.sampleFile, fixture.sample + "\n"]];
  checks.add("only declared fixture operations", uses.every(u => u.name === "Read" ? files.some(([f]) => samePath(u.input.file_path, f, workspace)) :
    u.name === "Edit" ? samePath(u.input.file_path, fixture.sourceFile, workspace) : u.name === "Bash" && u.input.command === fixture.testCommand.join(" ") &&
    !u.input.run_in_background && !u.input.dangerouslyDisableSandbox), "unexpected tool, path or command");
  for (const [file, original] of files) {
    const reads = uses.filter(u => u.name === "Read" && samePath(u.input.file_path, file, workspace));
    checks.add(`complete Read before tests: ${file}`, reads.some(u => {
      const r = returned(run, u);
      return first && r && r.position < first.position && fullRead(r, original, file, workspace) && (u.input.offset == null || u.input.offset === 1) && u.input.limit == null;
    }), "whole original file must be returned before initial Bash", !reads.length && !run.completed);
    checks.add(`successful Reads: ${file}`, reads.every(u => returned(run, u) && !returned(run, u).isError), "failed or missing Read result");
  }
  checks.add("exactly two foreground tests", bash.length === 2, `calls=${bash.length}`, !run.completed && bash.length < 2);
  checks.add("initial named test failures", foregroundResult(initialResult, 1) && tapReport(initialResult?.content, fixture, true).ok, "two failures and one pass expected", !initialResult && !run.completed);
  let source = null;
  if (edit && typeof edit.input.old_string === "string" && edit.input.old_string && typeof edit.input.new_string === "string" && !edit.input.replace_all && fixture.source.split(edit.input.old_string).length === 2) {
    source = fixture.source.replace(edit.input.old_string, edit.input.new_string);
  }
  const m = editResult?.metadata;
  const success = editResult && !editResult.isError && (m ? samePath(m.filePath, fixture.sourceFile, workspace) && m.originalFile === fixture.source &&
    m.oldString === edit.input.old_string && m.newString === edit.input.new_string && !m.staged && !m.replaceAll : /has been (?:updated|edited) successfully\./.test(editResult.content));
  checks.add("one successful source-only Edit", edits.length === 1 && allowedSource(source, fixture) && success, "only discount calculation may change", !edit && !run.completed);
  checks.add("failure then Edit then retest", Boolean(initialResult && edit && editResult && retest && initialResult.position < edit.position && editResult.position < retest.position), "required result order", !initialResult && !run.completed);
  checks.add("three passing retests", foregroundResult(retestResult, 0) && tapReport(retestResult?.content, fixture).ok, "all named tests must pass", !retestResult && !run.completed);
  return { source, checks: checks.items, outcome: checks.outcome };
}

export function matchingRequests(run) {
  const ids = new Set(run?.stream.messages.map(m => m.id));
  return (run?.observations ?? []).filter(r => r.event === "bridge.verify_request" && ids.has(r.responseId));
}
export function continuityChecks(before, after, checks) {
  checks.add("same CLI process and session", Number.isInteger(before?.pid) && before.pid === after?.pid && Boolean(sessionId(before)) && sessionId(before) === sessionId(after), "process or session changed", !before || !after);
}
export function clearChecks(before, after, seedHash, checks) {
  const requests = matchingRequests(after), previous = matchingRequests(before);
  checks.add("clear changes only the conversation", Boolean(sessionId(before)) && Boolean(sessionId(after)) && sessionId(before) !== sessionId(after) && before.pid === after.pid, "new session in same process required", !before || !after);
  checks.add("seed was actually sent", previous.some(r => r.userTextHashes?.includes(seedHash)), "missing original prompt digest", !previous.length);
  const oldText = new Set([seedHash, ...before.stream.messages.flatMap(m => m.blocks.map(b => b.block).filter(b => b.type === "text").map(b => digest(b.text)))]);
  checks.add("clear removes prior user text", requests.length > 0 && requests.every(r => Array.isArray(r.messageDigests) &&
    !r.messageDigests.some(m => m.textHashes?.some(h => oldText.has(h)))), "prior user and assistant text must not reach the new conversation", !requests.length);
}
export function modelStateChecks(run, model, checks, effort) {
  const messages = run?.stream.messages ?? [], observations = run?.observations ?? [];
  const records = [];
  for (const message of messages) {
    const completed = (run.sdkRecords ?? []).find(r => r.responseId === message.id);
    const rows = observations.filter(r => r.event === "bridge.verify_model_state" && r.responseId === message.id && r.requestId === completed?.requestId);
    checks.add(`${message.id} authoritative model state`, rows.length === 1 && rows[0].ok === true && sameModel(rows[0].current?.modelId, model), `states=${rows.length}`, !rows.length || rows.some(r => !r.ok || !r.current?.modelId));
    for (const row of rows) {
      records.push(row);
      checks.add(`${message.id} configured context tier`, row.current != null && (row.current.contextTier ?? null) === (row.requestedContextTier ?? null), "SDK tier must match actual session option", !row.current || (row.requestedContextTier != null && row.current.contextTier == null));
      if (effort !== undefined) {
        const matches = effort === null ? row.appliedEffort == null && [undefined, null, "none"].includes(row.current?.reasoningEffort) : row.requestedEffort === effort && row.appliedEffort === effort && row.current?.reasoningEffort === effort;
        checks.add(`${message.id} applied reasoning effort`, matches, `requested=${row.requestedEffort}; applied=${row.appliedEffort}; observed=${row.current?.reasoningEffort}`, !row.ok);
      }
    }
  }
  checks.add("model state exists", messages.length > 0 && records.length > 0, "no correlated model state", true);
  return records;
}
export function mcpChecks(run, ledger, valueHash, checks) {
  const uses = run.toolUses, results = uses.map(u => returned(run, u));
  checks.add("ordered native MCP calls", uses.length === 2 && uses.every(u => u.name === "mcp__fixture__lookup") && uses[0].input.key === "missing" && uses[1].input.key === "selected", "missing then selected, no extra tools");
  checks.add("MCP error before success", results.length === 2 && results[0]?.isError && /ENOENT/.test(results[0].content) && !results[1]?.isError && results[0].position < uses[1]?.position && digest(results[1]?.content.trim() ?? "") === valueHash, "returned error/value/order differs");
  const calls = ledger.filter(r => r.event === "request" && r.method === "tools/call");
  checks.add("MCP ledger calls", calls.length === 2 && calls.every(r => r.params?.name === "lookup") && calls[0]?.params.arguments?.key === "missing" && calls[1]?.params.arguments?.key === "selected", "ledger arguments differ");
  const replies = calls.map(call => ledger.filter(r => r.event === "response" && r.id === call.id && r.method === "tools/call"));
  checks.add("MCP ledger results", replies.length === 2 && replies.every(r => r.length === 1) && replies[0][0].result?.isError === true && /ENOENT/.test(JSON.stringify(replies[0][0].result)) &&
    replies[1][0].result?.isError !== true && digest(replies[1][0].result?.content?.map(c => c.text ?? "").join("\n") ?? "") === valueHash, "ledger results differ");
}
/** A text delta must belong to this request, and no terminal event may precede Escape. */
export function interruptState(rows, requestId) {
  const requests = rows.filter(r => r.event === "bridge.verify_request" && r.requestId === requestId);
  const request = requests[0];
  const same = r => Boolean(request) && r.requestId === requestId && r.responseId === request.responseId;
  const requestIndex = rows.indexOf(request);
  const progressIndex = rows.findIndex(r => same(r) && r.event === "bridge.verify_progress" && r.kind === "assistant.message_delta");
  const terminal = rows.filter(r => same(r) && ["bridge.turn_completed", "bridge.verify_response", "bridge.turn_aborted", "bridge.turn_abort_completed", "bridge.turn_timeout"].includes(r.event));
  const aborted = rows.filter(r => same(r) && r.event === "bridge.turn_aborted");
  const ack = rows.filter(r => same(r) && r.event === "bridge.turn_abort_completed");
  const responses = rows.filter(r => same(r) && r.event === "bridge.verify_response");
  const abortIndex = rows.indexOf(aborted[0]), ackIndex = rows.indexOf(ack[0]);
  return { request, requests, requestIndex, progressIndex, terminal, aborted, ack, responses, abortIndex, ackIndex,
    active: requests.length === 1 && request.streaming === true && progressIndex > requestIndex && terminal.length === 0,
    acknowledged: aborted.length === 1 && aborted[0].reason === "client_abort" && ack.length === 1 &&
      ack[0].reason === "client_abort" && ack[0].acknowledged === true && ackIndex > abortIndex,
    stopped: !rows.some(r => same(r) && r.event === "bridge.turn_completed") && responses.length === 1 &&
      responses[0].aborted === true && responses[0].finished === false };
}

const sequence = value => Number.isSafeInteger(value) && value >= 0;
const acceptedTestEscape = receipt => receipt?.kind === "escape" && receipt.purpose === "test-interrupt" &&
  receipt.accepted === true && receipt.byteCount === 1 && sequence(receipt.sequence) && receipt.sequence > 0 &&
  sequence(receipt.renderSequence) && sequence(receipt.outputSequence) &&
  sequence(receipt.writeOutputSequence) && receipt.writeOutputSequence >= receipt.outputSequence &&
  numeric(receipt.elapsedMs) && numeric(receipt.acknowledgedMs) && receipt.acknowledgedMs >= receipt.elapsedMs;

/** Shared by the saved gate and local preflight: a sent key is never proof. */
export function nativeInterruptionEvidence(run, receipt) {
  const interruption = run?.interruption, native = interruption?.nativeReceipt, id = sessionId(run);
  if (typeof id !== "string" || !id ||
      ["sessionId", "observedSessionId"].some(key => Object.hasOwn(run, key) && run[key] !== id)) return false;
  if (!acceptedTestEscape(receipt) || run?.interrupted !== true || !native || typeof native !== "object" || Array.isArray(native) ||
      interruption.escapeSequence !== receipt.sequence || interruption.ready !== true ||
      !sequence(native.renderSequence) || native.renderSequence <= receipt.renderSequence ||
      !sequence(native.outputSequence) || native.outputSequence <= receipt.writeOutputSequence ||
      !numeric(native.elapsedMs) || native.elapsedMs < receipt.acknowledgedMs ||
      !sequence(interruption.renderSequence) || interruption.renderSequence < native.renderSequence ||
      !sequence(interruption.outputSequence) || interruption.outputSequence < native.outputSequence ||
      typeof interruption.screen !== "string" || !terminalActivity(interruption.screen).ready) return false;
  if (native.kind === "render") return typeof native.screen === "string" && interruptionLines(native.screen).length > 0;
  if (native.kind !== "event") return false;
  const event = native.event, content = event?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
  const identities = [event?.sessionId, event?.session_id].filter(value => value !== undefined);
  return identities.length > 0 && identities.every(value => value === id) &&
    event?.type === "user" && event.parent_tool_use_id == null && event.isSidechain !== true &&
    /^\[Request interrupted by user(?: for tool use)?\]$/.test(text) &&
    (run.events ?? []).some(row => isDeepStrictEqual(row, event));
}

export function interruptVerdict(input, beforeEscape, requestId, ctx, policy, facts = {}) {
  const run = toRun(input), checks = new Checks(), rows = run?.observations ?? [];
  const before = interruptState(beforeEscape ?? [], requestId), after = interruptState(rows, requestId), request = before.request;
  checks.add("active streamed request before Escape", before.active, "ordered assistant.message_delta and no completion/abort required", !request);
  checks.add("interrupted root session", request?.claudeAgent === "root" && Boolean(sessionId(run)) && request?.claudeSessionId === sessionId(run), "request must belong to the active root CLI session", !request);
  checks.add("interrupted model requested", sameModel(request?.requestedModel, ctx.model), String(request?.requestedModel), !request);
  checks.add("pre-Escape log retained in order", Array.isArray(beforeEscape) && beforeEscape.length > 0 && isDeepStrictEqual(rows.slice(0, beforeEscape.length), beforeEscape), "prior observations must be an unchanged prefix", !beforeEscape);
  checks.add("readable interruption log", !run?.sdkLogError, run?.sdkLogError ?? "", true);
  const nativeBefore = facts.nativeBeforeEscape, receipt = facts.testEscape, nativeAfter = facts.nativeAfterInterrupt;
  checks.add("native active immediately before Escape", nativeBefore?.active === true && nativeBefore.interruptible === true && nativeBefore.ready === false && Number.isInteger(nativeBefore.renderSequence), "current native activity, not old transcript output", !nativeBefore);
  checks.add("one accepted test Escape receipt", acceptedTestEscape(receipt) && receipt.renderSequence >= nativeBefore?.renderSequence,
  "acknowledged test-interrupt receipt required; cleanup is not test evidence", !receipt);
  checks.add("SDK abort acknowledged", after.requests.length === 1 && after.acknowledged && after.abortIndex >= (beforeEscape?.length ?? Infinity),
    "one correlated client abort followed by its acknowledgment, after Escape", !after.aborted.length || !after.ack.length);
  checks.add("interrupted response never completes", after.stopped && rows.indexOf(after.responses[0]) >= (beforeEscape?.length ?? Infinity),
    "interrupted transport required; normal completion cannot count", !after.responses.length);
  if (run) {
    checks.add("interrupted native evidence readable", run.nativeTurn === true && !run.parseErrors && !run.ioError && !run.timedOut && !run.spawnError,
      "native interruption evidence must be readable", Boolean(run.timedOut || run.spawnError));
    isolationChecks(run, policy, checks);
    checks.add("interrupted turn uses no tools", !run.toolUses.length && !run.toolResults.length, "unexpected tools");
    checks.add("native interruption evidence", nativeInterruptionEvidence(run, receipt),
    "correlated native interrupt marker after acknowledged Escape required, not a sent key", !run.interruption);
    checks.add("native ready after interruption", run.interruption?.ready === true && nativeAfter?.ready === true && nativeAfter.active === false && nativeAfter.interruptible === false &&
      Number.isInteger(nativeAfter.renderSequence) && nativeAfter.renderSequence >= run.interruption?.renderSequence,
    "submit must settle and the native prompt must be ready", !nativeAfter);
  }
  const t = facts.interruptTiming, b = t?.budgets;
  const finite = (...values) => values.every(numeric);
  checks.add("bounded interruption phases", b && Object.values(b).length === 4 && Object.values(b).every(v => numeric(v) && v > 0) &&
    finite(t.startedAt, t.slotDeadline, t.progressDeadline, t.interruptDeadline, t.recoveryDeadline, t.escapeAt, t.settleDeadline, t.settledAt, t.ackAt, t.readyAt) &&
    t.recoveryDeadline === t.slotDeadline - b.cleanupMs && t.interruptDeadline === t.recoveryDeadline - b.recoveryMs &&
    t.progressDeadline <= t.startedAt + b.progressMs && t.progressDeadline <= t.interruptDeadline - b.settleMs &&
    t.escapeAt >= t.startedAt && t.escapeAt < t.progressDeadline && t.settleDeadline <= t.escapeAt + b.settleMs && t.settleDeadline <= t.interruptDeadline &&
    t.settledAt >= t.escapeAt && t.settledAt <= t.settleDeadline && t.ackAt >= t.escapeAt && t.ackAt < t.settleDeadline &&
    t.readyAt >= t.settledAt && t.readyAt < t.settleDeadline && t.observerCancelled !== true,
  "recorded deadlines must preserve recovery/cleanup; cancelled observers do not pass", !t);
  const records = rows.filter(r => request && r.requestId === requestId && r.responseId === request.responseId);
  return { outcome: checks.outcome, reason: checks.reason, checks: checks.items, completed: false, interrupted: checks.outcome === "pass",
    requestedModels: request ? [request.requestedModel] : [], sdk: { records, responseIds: request ? [request.responseId] : [], servedModels: [] },
    pid: run?.pid, sessionId: sessionId(run), transcriptPath: run?.transcriptPath, raw: input, beforeEscape, requestId };
}

const COMPACT_PREFIX = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_TRANSCRIPT = "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ";

/** Link the saved native summary to its own request and response, not side traffic. */
export function compactLinkChecks(run, checks = new Checks()) {
  const events = run?.events ?? [], rows = run?.observations ?? [], id = sessionId(run);
  const boundaries = events.filter(e => e.type === "system" && e.subtype === "compact_boundary");
  const summaries = events.filter(e => e.isCompactSummary === true);
  const boundary = boundaries[0], summary = summaries[0];
  const nativeSession = e => e?.sessionId ?? e?.session_id;
  checks.add("native compact boundary", boundaries.length === 1 && boundary.compactMetadata?.trigger === "manual" &&
    typeof boundary.uuid === "string" && Boolean(id) && nativeSession(boundary) === id && !boundary.isSidechain,
  "one manual boundary in the active session required", !boundaries.length);
  checks.add("saved compact summary parent", summaries.length === 1 && summary.type === "user" && summary.message?.role === "user" &&
    typeof summary.uuid === "string" && summary.parentUuid === boundary?.uuid && nativeSession(summary) === id && !summary.isSidechain,
  "one native summary attached to that boundary and session required", !summaries.length);
  const content = summary?.message?.content;
  const end = typeof content === "string" ? content.lastIndexOf(COMPACT_TRANSCRIPT) : -1;
  const savedText = typeof content === "string" && content.startsWith(COMPACT_PREFIX) && end > COMPACT_PREFIX.length
    ? content.slice(COMPACT_PREFIX.length, end) : null;
  const transcript = end >= 0 ? content.slice(end + COMPACT_TRANSCRIPT.length).split("\n")[0] : null;
  checks.add("compact transcript linkage", Boolean(savedText) && typeof run?.transcriptPath === "string" &&
    transcript === run.transcriptPath && path.basename(transcript) === `${id}.jsonl`,
  "native summary must reference its own saved transcript", !summary);
  const completions = rows.filter(r => r.event === "bridge.turn_completed");
  const linked = completions.filter(r => savedText && r.compactSummarySha256 === digest(savedText));
  checks.add("summary response content linkage", linked.length === 1, "exactly one response digest must match the stored summary", !completions.length);
  const completion = linked[0];
  const requests = completion ? rows.filter(r => r.event === "bridge.verify_request" && r.requestId === completion.requestId && r.responseId === completion.responseId) : [];
  checks.add("summary request session linkage", requests.length === 1 && requests[0].claudeSessionId === id &&
    requests[0].claudeAgent === "root" && requests[0].compactRequested === true && completion?.claudeAgent === "root",
  "matching root summary request in the active CLI session required", !requests.length);
  return { boundary, summary, responseId: completion?.responseId ?? null, checks: checks.items, outcome: checks.outcome, reason: checks.reason };
}

/** A compact boundary is not an assistant response; validate its real summary call separately. */
export function compactVerdict(input, ctx, policy) {
  const run = toRun(input), checks = new Checks(), rows = run?.observations ?? [];
  compactLinkChecks(run, checks);
  const completions = rows.filter(r => r.event === "bridge.turn_completed");
  checks.add("actual summary response", completions.length > 0, "no summary request/completion", true);
  for (const row of completions) {
    const request = rows.filter(r => r.event === "bridge.verify_request" && r.requestId === row.requestId && r.responseId === row.responseId);
    const response = rows.filter(r => r.event === "bridge.verify_response" && r.requestId === row.requestId && r.responseId === row.responseId);
    checks.add(`${row.responseId} summary identity`, sameModel(row.model, ctx.model) && sameModel(row.requestedModel, ctx.model) && Array.isArray(row.servedModels) && row.servedModels.length > 0 && row.servedModels.every(m => sameModel(m, ctx.model)), "summary model mismatch", !row.servedModels?.length);
    checks.add(`${row.responseId} summary transport`, request.length === 1 && response.length === 1 && response[0].status === 200 && response[0].finished && !response[0].aborted, "complete summary HTTP response required", !request.length || !response.length);
    checks.add(`${row.responseId} summary usage`, row.usageReported === true && numeric(row.inputTokens) && row.inputTokens > 0 && numeric(row.outputTokens) && row.outputTokens > 0 && row.stopReason === "end_turn" && row.toolUses === 0, "complete no-tool summary required");
  }
  if (run) {
    checks.add("compact native evidence readable", run.nativeTurn === true && !run.parseErrors && !run.ioError && !run.timedOut && !run.spawnError,
      "native compaction evidence must be readable", Boolean(run.timedOut || run.spawnError));
    isolationChecks(run, policy, checks);
  }
  return { outcome: checks.outcome, reason: checks.reason, checks: checks.items, completed: checks.outcome === "pass",
    requestedModels: [...new Set(completions.map(r => r.requestedModel))], sdk: { records: completions, responseIds: completions.map(r => r.responseId), servedModels: [...new Set(completions.flatMap(r => r.servedModels ?? []))], logRange: run?.sdkLogRange },
    pid: run?.pid, sessionId: sessionId(run), transcriptPath: run?.transcriptPath, raw: input };
}

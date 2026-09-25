/** Pure gates shared by live execution and saved-evidence rechecks. */
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { copilotModelForFrontend } from "../../src/model-map.mjs";
import { HeadlessRun, usageReport } from "./session.mjs";
import { digest } from "./fixtures.mjs";

export class Checks {
  items = [];
  add(name, ok, detail = "", missing = false) {
    this.items.push({ name, ok: Boolean(ok), detail: String(detail), outcome: ok ? "pass" : missing ? "blocked" : "fail" });
    return Boolean(ok);
  }
  get outcome() { return this.items.some(x => x.outcome === "fail") ? "fail" : this.items.some(x => !x.ok) ? "blocked" : "pass"; }
  get reason() { return this.items.filter(x => !x.ok).map(x => `${x.name}: ${x.detail || "not satisfied"}`).join("; "); }
}
export const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const usable = value => typeof value === "string" && value.trim().length > 0;
export const sameModel = (value, expected) => usable(value) && copilotModelForFrontend(value) === copilotModelForFrontend(expected);
export const logSize = file => { try { return fs.statSync(file).size; } catch { return null; } };

export function readLog(file, start = 0) {
  const end = logSize(file), rows = [];
  let error = null;
  try {
    if (start == null || end == null || end < start || end - start > 8 * 1024 * 1024) throw new Error("missing or oversized log range");
    const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(end - start);
    try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); }
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try { rows.push(JSON.parse(line)); } catch { error = "malformed diagnostic record"; }
    }
  } catch (e) { error = e.message; }
  return { rows, error, range: { path: file ?? null, start, end } };
}

export async function attachLog(run, file, start) {
  const deadline = Date.now() + 750;
  let log;
  do {
    log = readLog(file, start);
    const ids = run.stream.messages.map(m => m.id).filter(Boolean);
    if (log.error || ids.every(id => log.rows.some(r => r.event === "bridge.turn_completed" && r.responseId === id) &&
      log.rows.some(r => r.event === "bridge.verify_response" && r.responseId === id))) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  Object.assign(run, { sdkRecords: log.rows.filter(r => r.event === "bridge.turn_completed"), observations: log.rows,
    sdkLogError: log.error, sdkLogRange: log.range });
  return run;
}

/** Every root response, not a side call or the CLI's requested-model label. */
export function sdkEvidence(run, model, checks, { observe = true } = {}) {
  const stream = run.stream, rows = run.sdkRecords ?? [], matched = [];
  checks.add("root response IDs", stream.messages.length > 0 && !stream.missing.length, stream.missing.join(", "), true);
  checks.add("readable bridge evidence", !run.sdkLogError, run.sdkLogError ?? "", true);
  for (const message of stream.messages) {
    const stop = message.tools.length ? "tool_use" : "end_turn";
    checks.add(`${message.id} native stop`, message.stopReasons.every(s => s === stop), message.stopReasons.join(", "));
    const matches = rows.filter(r => r.responseId === message.id);
    checks.add(`${message.id} completion correlation`, matches.length === 1, `records=${matches.length}`, !matches.length);
    for (const row of matches) {
      matched.push(row);
      checks.add(`${message.id} root completion`, row.claudeAgent === "root", String(row.claudeAgent), row.claudeAgent == null);
      for (const [kind, value] of [["requested", row.requestedModel], ["resolved", row.model],
        ...(Array.isArray(row.servedModels) ? row.servedModels.map(v => ["served", v]) : [])]) {
        checks.add(`${message.id} ${kind} model`, sameModel(value, model), `${value ?? "unknown"}; expected ${model}`, !usable(value));
      }
      checks.add(`${message.id} SDK models present`, Array.isArray(row.servedModels) && row.servedModels.length > 0, "SDK must report model IDs", true);
      checks.add(`${message.id} SDK usage reported`, row.usageReported === true, String(row.usageReported), row.usageReported == null || row.usageReported === false);
      const missing = row.inputTokens == null || row.outputTokens == null;
      const invalid = [row.inputTokens, row.outputTokens].some(v => v != null && !numeric(v));
      checks.add(`${message.id} SDK usage valid`, !missing && !invalid, "finite nonnegative counters required", missing && !invalid);
      checks.add(`${message.id} SDK stop reason`, row.stopReason === stop, String(row.stopReason), row.stopReason == null);
      checks.add(`${message.id} SDK tool count`, row.toolUses === message.tools.length, String(row.toolUses), row.toolUses == null);
      if (observe) transportChecks(row, run.observations ?? [], checks, run.observedSessionId ?? run.sessionId);
    }
  }
  if (matched.length && matched.every(r => numeric(r.inputTokens) && numeric(r.outputTokens))) {
    const input = matched.reduce((n, r) => n + r.inputTokens, 0), output = matched.reduce((n, r) => n + r.outputTokens, 0);
    checks.add("SDK input/output activity", numeric(input) && input > 0 && numeric(output) && output > 0,
      "finite positive phase totals required");
  }
  return { outcome: checks.outcome, responseIds: stream.messages.map(m => m.id), records: matched, logRange: run.sdkLogRange ?? null,
    servedModels: [...new Set(matched.flatMap(r => Array.isArray(r.servedModels) ? r.servedModels.filter(usable) : []))],
    requestedModels: [...new Set(matched.map(r => r.requestedModel).filter(usable))] };
}

function transportChecks(row, observations, checks, sessionId) {
  const requests = observations.filter(r => r.event === "bridge.verify_request" && r.responseId === row.responseId && r.requestId === row.requestId);
  const responses = observations.filter(r => r.event === "bridge.verify_response" && r.responseId === row.responseId && r.requestId === row.requestId);
  checks.add(`${row.responseId} Messages request`, requests.length === 1 && requests[0].streaming === true, `requests=${requests.length}`, !requests.length);
  checks.add(`${row.responseId} request session`, usable(sessionId) && requests.length === 1 && requests[0].claudeSessionId === sessionId,
    "the correlated request must belong to the native session", !usable(sessionId) || !requests.length || !usable(requests[0]?.claudeSessionId));
  checks.add(`${row.responseId} Messages completed`, responses.length === 1 && responses[0].status === 200 && responses[0].finished === true && !responses[0].aborted,
    `responses=${responses.length}`, !responses.length);
}

export function isolationChecks(run, policy, checks) {
  const init = run.init;
  if (init) {
    checks.add("declared tool surface", Array.isArray(init.tools) && init.tools.every(t => policy.tools.includes(t)) && policy.tools.every(t => init.tools.includes(t)), JSON.stringify(init.tools), !Array.isArray(init.tools));
    checks.add("verified builtin plugins only", Array.isArray(init.plugins) && Array.isArray(policy.plugins) && isDeepStrictEqual(init.plugins, policy.plugins), JSON.stringify(init.plugins), !Array.isArray(init.plugins) || !Array.isArray(policy.plugins));
    checks.add("no external skills", Array.isArray(init.skills) && init.skills.length === 0, JSON.stringify(init.skills), !Array.isArray(init.skills));
    checks.add("declared MCP servers only", Array.isArray(init.mcp_servers) && init.mcp_servers.length === policy.mcpServers.length &&
      init.mcp_servers.every(s => policy.mcpServers.includes(s.name) && s.status === "connected"), JSON.stringify(init.mcp_servers), !Array.isArray(init.mcp_servers));
    checks.add("no plugin/MCP load errors", !init.plugin_errors?.length && !init.mcp_server_errors?.length, "declared capabilities must load");
  } else if (run.nativeTurn) {
    // Native TUI has no stream-json init. Its adapter retains the actual launch
    // policy; the installed binary and private configuration are checked too.
    const launch = run.launchPolicy;
    const arg = flag => Array.isArray(launch?.args) && launch.args.includes(flag) ? launch.args[launch.args.indexOf(flag) + 1] : undefined;
    const paths = [launch?.home, launch?.configDir, launch?.workspace, launch?.tmpDir];
    checks.add("native isolated launch", Boolean(launch) && paths.every(p => typeof p === "string" && p.startsWith("/")) &&
      launch.home !== launch.workspace && launch.configDir !== launch.workspace &&
      arg("--setting-sources") === "" && launch.args.includes("--strict-mcp-config") && launch.args.includes("--no-chrome") &&
      arg("--permission-mode") === "dontAsk" && arg("--tools") === policy.tools.join(",") &&
      arg("--settings") === launch.isolationSettingsPath && /^[a-f0-9]{64}$/.test(launch.settingsSha256 ?? "") &&
      /^[a-f0-9]{64}$/.test(launch.isolationSettingsSha256 ?? "") &&
      launch.settings?.disableAllHooks === true && launch.settings.autoMemoryEnabled === false &&
      launch.settings.enableAllProjectMcpServers === false && isDeepStrictEqual(launch.settings.enabledPlugins, {}) &&
      isDeepStrictEqual(launch.tools, policy.tools) && isDeepStrictEqual(launch.mcpServers, policy.mcpServers),
    "actual private launch arguments and settings are required", !launch);
  } else checks.add("CLI initialization evidence", false, "missing init", true);
  checks.add("no memory/custom hooks", !run.events.some(e => /^(?:memory_recall|hook_started|hook_progress|hook_response|plugin_install)$/.test(e.type === "system" ? e.subtype : e.type)), "undeclared helper event");
  checks.add("no child actors", !run.events.some(e => e.parent_tool_use_id != null || e.isSidechain === true), "only root actors are allowed");
}

export function toRun(input) {
  if (!input || input instanceof HeadlessRun) return input;
  const { answer, sessionId, completed, result, results, stream, usage, toolUses, toolResults, ...fields } = input;
  return new HeadlessRun({ ...fields, observedSessionId: input.observedSessionId ?? sessionId });
}

export function phaseVerdict(label, input, ctx, policy = {}) {
  const checks = new Checks();
  const run = toRun(input);
  if (!run) {
    checks.add("phase ran", false, "required phase did not run", true);
    return { outcome: "blocked", reason: checks.reason, checks: checks.items, completed: false, sdk: { outcome: "blocked", servedModels: [] }, requestedModels: [] };
  }
  if (!run.nativeTurn) {
    checks.add("CLI completed cleanly", run.completed, run.failureHint ?? "exit 0", !run.results.length && (run.spawnError || run.timedOut || run.exitCode === 0));
    const usage = usageReport(run.usage);
    checks.add("CLI usage", usage.ok, JSON.stringify(usage), usage.missing && !usage.invalid.length);
  } else checks.add("native turn readable", !run.ioError && !run.parseErrors && !run.timedOut && !run.spawnError, run.ioError || run.spawnError || "native transcript", Boolean(run.timedOut || run.spawnError));
  const pairing = run.pairingReport();
  checks.add("ordered tool pairing", pairing.ok, JSON.stringify(pairing));
  checks.add("final root answer", run.answer.length > 0 && run.stream.messages.at(-1)?.tools.length === 0, "new complete assistant answer required", !run.stream.messages.length);
  if (policy.answer !== undefined || policy.answerSha256) checks.add("exact answer", policy.answerSha256 ? digest(run.answer) === policy.answerSha256 : run.answer === policy.answer, "entire fresh answer must match", !run.stream.messages.length);
  const tools = policy.tools ?? [], mcpServers = policy.mcpServers ?? [];
  checks.add("permitted runtime tools", run.toolUses.every(u => (policy.runtimeTools ?? tools).includes(u.name)), run.toolNames().join(", "));
  checks.add("only declared tool errors", run.toolResults.every(r => !r.isError || (policy.expectedErrorIds ?? []).includes(r.id)), "unexpected failed tool result");
  checks.add("no denied permissions", !run.result?.permission_denials?.length && !run.events.some(e => e.subtype === "permission_denied"), "tool permission denial");
  isolationChecks(run, { tools, mcpServers, plugins: ctx.preflight?.plugins }, checks);
  const sdkChecks = new Checks(), sdk = sdkEvidence(run, policy.model ?? ctx.model, sdkChecks);
  checks.items.push(...sdkChecks.items);
  return { outcome: checks.outcome, reason: checks.reason, checks: checks.items, completed: run.nativeTurn ? sdk.outcome === "pass" : run.completed,
    requestedModels: sdk.requestedModels, sdk, pairing, transcriptPath: run.transcriptPath ?? null, pid: run.pid, sessionId: run.observedSessionId ?? run.sessionId,
    raw: { events: run.events, observedSessionId: run.observedSessionId, pid: run.pid, transcriptPath: run.transcriptPath, nativeTurn: run.nativeTurn ?? false, launchPolicy: run.launchPolicy, observations: run.observations,
      sdkRecords: run.sdkRecords, sdkLogRange: run.sdkLogRange, sdkLogError: run.sdkLogError, exitCode: run.exitCode, signal: run.signal,
      timedOut: run.timedOut, spawnError: run.spawnError, ioError: run.ioError, parseErrors: run.parseErrors } };
}

export function workspaceCheck(before, after, sourceFile, source, checks) {
  const expected = structuredClone(before.entries);
  if (sourceFile && source != null && expected[sourceFile]) expected[sourceFile].sha256 = source;
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(after.entries)])].filter(k => !isDeepStrictEqual(expected[k], after.entries[k]));
  return checks.add("workspace invariants", !before.errors.length && !after.errors.length && changed.length === 0 &&
    Object.values(after.entries).every(e => ["file", "directory"].includes(e.type)), changed.join(", ") || [...before.errors, ...after.errors].join(", "));
}

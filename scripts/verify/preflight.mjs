/** Actual installed CLI against loopback fixtures only; never a Copilot result. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isEntryPoint } from "../../src/entry-point.mjs";
import { PRIMARY_MODELS, launchModelFor, copilotModelForFrontend } from "../../src/model-map.mjs";
import { claudeVersion, seedConfigDir, writeLaunchSettings, resolveClaudeBin } from "./bridge.mjs";
import { InteractiveSession, privateCLIEnv } from "./interactive.mjs";
import { runHeadless } from "./session.mjs";
import { buildFixture, digest } from "./fixtures.mjs";
import { Checks } from "./evidence.mjs";
import { codingChecks, mcpChecks, compactLinkChecks, nativeInterruptionEvidence } from "./scenario-checks.mjs";
import { startLocalAPI } from "../../test/fixtures/verify-local-api.mjs";
import { configEvidence } from "./drivers.mjs";

export function builtinPlugins(plugins) {
  return Array.isArray(plugins) && plugins.every(p => ["agents-md", "telemetry"].includes(p.name) &&
    p.path === "builtin" && p.source === `${p.name}@builtin`) && new Set(plugins.map(p => p.name)).size === plugins.length;
}
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const normalExit = receipt => receipt?.ok === true && receipt.groupGone === true && receipt.exitCode === 0 && receipt.signal == null;
const LOCAL_BUDGETS = Object.freeze({ sessionMs: 240000, commandMs: 15000, turnMs: 30000, codingMs: 90000 });

/** Production launch settings (Bearer ANTHROPIC_AUTH_TOKEN, blank ANTHROPIC_API_KEY) plus isolation controls. */
export function writePreflightSettings(settingsPath, api, frontendModel) {
  writeLaunchSettings({ bridge: { ...api, frontendModel }, settingsPath });
  const settings = JSON.parse(fs.readFileSync(settingsPath));
  settings.autoMemoryEnabled = false; settings.disableAllHooks = true; settings.hooks = {}; settings.enabledPlugins = {};
  fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
}

export async function preflightCheck(result, name, work, requires = []) {
  const missing = requires.filter(key => result.checks[key]?.ok !== true);
  if (missing.length) {
    result.checks[name] = { ok: false, skipped: true, reason: `Prerequisite failed: ${missing.join(", ")}` };
    return;
  }
  try { await work(); result.checks[name] = { ok: true }; }
  catch (error) { result.checks[name] = { ok: false, reason: error.message }; }
}

/** A failed local interruption must settle its observer before any later turn. */
export async function checkLocalInterruption(native, api, prompt) {
  const start = api.records.length, controller = new AbortController();
  const pid = native.pid, sessionId = native.sessionId;
  let settled = false, receipt;
  const pending = native.submit(prompt, { timeoutMs: 15000, signal: controller.signal })
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await native.waitFor(() => {
      if (settled) throw new Error("Local stream ended before interruption");
      const rows = api.records.slice(start), progress = rows.find(r => r.type === "progress");
      return progress && !rows.some(r => r.type === "response" && r.id === progress.id) && native.activity().interruptible;
    }, { timeoutMs: 5000, label: "active local text stream" });
    const id = api.records.slice(start).find(r => r.type === "progress").id;
    receipt = await native.escape({ purpose: "test-interrupt", timeoutMs: 2000 });
    assert.equal(receipt.kind, "escape"); assert.equal(receipt.purpose, "test-interrupt");
    assert.equal(receipt.accepted, true);
    const ended = await pending; if (ended.error) throw ended.error;
    assert.equal(ended.value.interrupted, true);
    assert.ok(nativeInterruptionEvidence(ended.value, receipt), "Fresh sequence-bound native interruption evidence required");
    assert.equal(ended.value.interruption.ready, true);
    assert.equal(native.activeSubmit, false);
    await native.waitFor(() => api.records.some(r => r.type === "response" && r.id === id && r.aborted && !r.finished),
      { timeoutMs: 5000, label: "local interrupted response close" });
    assert.equal(native.pid, pid); assert.equal(native.sessionId, sessionId);
    const evidence = { prompt, id, receipt, interruption: ended.value.interruption };
    assert.equal((await native.submit("LOCAL_REPLY=LOCAL_RECOVERED", { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, "LOCAL_RECOVERED");
    return evidence;
  } finally {
    // Cancellation releases only the observer. A cleanup Escape is not a test
    // interruption and must never permit a subsequent phase to count as passed.
    try {
      if (!settled && !receipt) await native.escape({ purpose: "cleanup", timeoutMs: 2000 });
    } finally { controller.abort(); await pending; }
  }
}

export async function preflightCLI({ claudeBin, directory }) {
  const bin = fs.realpathSync(claudeBin), version = claudeVersion(bin);
  const result = { mode: "local-mock-only", claude: { bin, version, sha256: digest(fs.readFileSync(bin)) },
    budgets: LOCAL_BUDGETS, scenarios: {}, checks: {}, plugins: null, cleanup: { ok: true, receipts: [] } };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-preflight-")));
  result.workspaceRoot = temp;
  const isolated = new Map();
  const finishCLI = async native => {
    const receipt = await native.close(); result.cleanup.receipts.push(receipt);
    if (!receipt.ok) result.cleanup.ok = false;
    const state = isolated.get(native.options.configDir);
    if (state) {
      state.inputs.push(...native.inputs);
      state.sessions.add(native.sessionId);
      for (const events of native.files.values()) for (const event of events) {
        if (event.session_id) state.sessions.add(event.session_id);
      }
    }
    return receipt;
  };
  const check = (name, work, requires) => preflightCheck(result, name, work, requires);
  const prepare = (label, api, model = "claude-sonnet-5") => {
    const slotDir = path.join(directory, label), configDir = path.join(slotDir, "config"), workspace = path.join(temp, label);
    fs.mkdirSync(slotDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
    seedConfigDir(configDir, { version });
    const settingsPath = path.join(slotDir, "settings.json"), frontendModel = launchModelFor(model);
    writePreflightSettings(settingsPath, api, frontendModel);
    const options = { claudeBin: bin, workspace, configDir, settingsPath, frontendModel, slotDir, timeoutMs: LOCAL_BUDGETS.sessionMs };
    isolated.set(configDir, { options, inputs: [], sessions: new Set() });
    return options;
  };
  const api = await startLocalAPI({ directory: path.join(directory, "api") });
  let native;
  try {
    await check("print", async () => {
      const options = prepare("print", api), home = path.join(options.slotDir, "home"), tmpDir = path.join(options.slotDir, "tmp");
      fs.mkdirSync(home); fs.mkdirSync(tmpDir);
      const run = await runHeadless({ ...options, cwd: options.workspace, timeoutSeconds: 20,
        env: {}, childEnv: privateCLIEnv({ home, configDir: options.configDir, tmpDir, env: process.env }),
        prompt: "LOCAL_REPLY=LOCAL_PRINT_OK", transcriptPath: path.join(options.slotDir, "stream.jsonl"),
        extraArgs: ["--restricted", "--tools", "", "--permission-mode", "dontAsk", "--session-id", randomUUID()] });
      result.cleanup.receipts.push(run.cleanup); result.cleanup.ok &&= run.cleanup?.ok === true;
      for (const event of run.events) if (event.session_id) isolated.get(options.configDir).sessions.add(event.session_id);
      assert.ok(run.completed, run.failureHint); assert.equal(run.answer, "LOCAL_PRINT_OK");
      assert.ok(normalExit(run.cleanup), "Print CLI cleanup failed");
      assert.ok(builtinPlugins(run.init?.plugins), "Unverified external/builtin plugin descriptor");
      assert.deepEqual(run.init?.mcp_servers, []); assert.deepEqual(run.init?.skills, []);
      result.plugins = run.init.plugins;
    });
    await check("startup-repetitions", async () => {
      result.startups = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        const session = new InteractiveSession(prepare(`startup-${attempt}`, api));
        const observation = { attempt, ok: false };
        try {
          await session.start();
          assert.equal(session.activity().ready, true);
          observation.ok = true;
        } catch (error) { observation.reason = error.message; }
        finally {
          const receipt = await finishCLI(session);
          observation.inputReceipts = session.inputReceipts;
          observation.cleanup = receipt;
          if (!normalExit(receipt)) { observation.ok = false; observation.reason ??= "Startup CLI did not exit normally"; }
          result.startups.push(observation);
        }
      }
      assert.ok(result.startups.every(s => s.ok), result.startups.filter(s => !s.ok).map(s => `${s.attempt}: ${s.reason}`).join("; "));
    });
    const options = prepare("native", api);
    native = new InteractiveSession(options);
    await check("native", () => native.start());
    if (result.checks.native.ok) {
      await check("unicode-picker-clear", async () => {
        const picker = (await native.command("/model", { timeoutMs: LOCAL_BUDGETS.commandMs })).picker;
        assert.deepEqual(picker.models, PRIMARY_MODELS); assert.equal(picker.current, "claude-sonnet-5");
        await native.escape({ purpose: "picker-dismiss", timeoutMs: LOCAL_BUDGETS.commandMs });
        const unicode = await native.submit("LOCAL_REPLY=안녕 café", { timeoutMs: LOCAL_BUDGETS.turnMs });
        assert.equal(unicode.answer, "안녕 café");
        assert.equal((await native.submit("LOCAL_NONCE=preclear_nonce", { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, "LOCAL_REMEMBERED");
        const old = native.sessionId;
        await native.command("/clear", { timeoutMs: LOCAL_BUDGETS.commandMs });
        const cleared = await native.submit("LOCAL_RECALL", { timeoutMs: LOCAL_BUDGETS.turnMs });
        assert.notEqual(cleared.sessionId, old); assert.equal(cleared.answer, "LOCAL_UNKNOWN");
        assert.ok(!JSON.stringify(api.records.filter(r => r.type === "request").at(-1).body.messages).includes("preclear_nonce"));
      });
      await check("model-effort", async () => {
        await native.command(`/model ${launchModelFor("gpt-6-astra")}`, { timeoutMs: LOCAL_BUDGETS.commandMs });
        await native.command("/effort high", { timeoutMs: LOCAL_BUDGETS.commandMs });
        const switched = await native.submit("LOCAL_REPLY=LOCAL_SWITCH_OK", { timeoutMs: LOCAL_BUDGETS.turnMs });
        assert.equal(switched.answer, "LOCAL_SWITCH_OK");
        const request = api.records.filter(r => r.type === "request").at(-1);
        assert.equal(copilotModelForFrontend(request.body.model), "gpt-6-astra");
        assert.equal(request.body.output_config.effort, "high");
      }, ["unicode-picker-clear"]);
      await check("interrupt", async () => {
        result.interruptions = [];
        for (const prompt of ["LOCAL_LONG_STREAM", "LOCAL_DELAYED_STREAM"]) {
          result.interruptions.push(await checkLocalInterruption(native, api, prompt));
        }
      }, ["model-effort"]);
      await check("compact-resume", async () => {
        const nonce = `local_${randomUUID().replaceAll("-", "")}`;
        assert.equal((await native.submit(`LOCAL_NONCE=${nonce}`, { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, "LOCAL_REMEMBERED");
        const oldId = native.sessionId, oldPid = native.pid, start = api.records.length;
        const compacted = await native.command("/compact", { timeoutMs: 15000 });
        const observations = api.records.slice(start).flatMap(r => r.type === "request" ? [r.observation] :
          r.type === "response" && r.finished ? [{ event: "bridge.turn_completed", requestId: r.id, responseId: r.id,
            claudeAgent: "root", compactSummarySha256: r.compactSummarySha256 }] : []);
        const linked = compactLinkChecks({ ...compacted, observations });
        assert.equal(linked.outcome, "pass", linked.reason);
        const { boundary, summary } = linked;
        assert.equal((await native.submit("LOCAL_RECALL", { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, nonce);
        assert.ok(normalExit(await finishCLI(native)), "Native exit before resume was not normal");
        native = new InteractiveSession({ ...options, sessionId: oldId });
        await native.start({ resume: true });
        assert.notEqual(native.pid, oldPid); assert.equal(native.sessionId, oldId);
        assert.ok(native.readEvents().some(e => e.uuid === boundary.uuid));
        assert.ok(native.readEvents().some(e => e.uuid === summary.uuid && e.parentUuid === boundary.uuid &&
          JSON.stringify(e.message) === JSON.stringify(summary.message)));
        assert.equal((await native.submit("LOCAL_RECALL", { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, nonce);
      }, ["interrupt"]);
    }
  } finally {
    if (native) await check("native-cleanup", async () => assert.ok(normalExit(await finishCLI(native)), "Native exit/cleanup failed"));
    const receipt = await api.close(); result.cleanup.receipts.push(receipt); result.cleanup.ok &&= receipt.ok;
  }
  await check("coding", async () => {
    const workspace = path.join(temp, "coding-fixture"), fixture = buildFixture("V02", workspace);
    const local = await startLocalAPI({ directory: path.join(directory, "coding-api"), codingFixture: fixture });
    try {
      const options = prepare("coding", local); options.workspace = workspace;
      const home = path.join(options.slotDir, "home"), tmpDir = path.join(options.slotDir, "tmp"); fs.mkdirSync(home); fs.mkdirSync(tmpDir);
      const run = await runHeadless({ ...options, cwd: workspace, timeoutSeconds: LOCAL_BUDGETS.codingMs / 1000,
        env: {}, childEnv: privateCLIEnv({ home, configDir: options.configDir, tmpDir, env: process.env }),
        prompt: "LOCAL_CODE", transcriptPath: path.join(options.slotDir, "stream.jsonl"),
        extraArgs: ["--restricted", "--tools", "Read,Edit,Bash", "--permission-mode", "dontAsk", "--allowedTools", "Read", "Edit", `Bash(${fixture.testCommand.join(" ")})`] });
      result.cleanup.receipts.push(run.cleanup); result.cleanup.ok &&= run.cleanup?.ok === true;
      for (const event of run.events) if (event.session_id) isolated.get(options.configDir).sessions.add(event.session_id);
      assert.ok(run.completed, run.failureHint); assert.ok(normalExit(run.cleanup));
      const checks = new Checks(); codingChecks(run, { fixture, workspace }, checks);
      assert.equal(checks.outcome, "pass", checks.reason); assert.equal(run.answer, fixture.sample);
      assert.deepEqual(run.init.plugins, result.plugins);
    } finally { const receipt = await local.close(); result.cleanup.receipts.push(receipt); result.cleanup.ok &&= receipt.ok; }
  });
  await check("mcp", async () => {
    const local = await startLocalAPI({ directory: path.join(directory, "mcp-api") });
    let session;
    try {
      const options = prepare("mcp", local), value = `mcp_${randomUUID()}`;
      const valueFile = path.join(options.slotDir, "value.txt"), ledgerFile = path.join(options.slotDir, "ledger.jsonl");
      fs.writeFileSync(valueFile, value, { mode: 0o600 });
      session = new InteractiveSession({ ...options, tools: ["mcp__fixture__lookup"], mcpConfig: { mcpServers: { fixture: {
        type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url)), valueFile, ledgerFile],
      } } } });
      await session.start();
      const first = await session.submit("LOCAL_MCP", { timeoutMs: 15000 });
      assert.equal(first.answer, value);
      const { toRun } = await import("./evidence.mjs");
      const checks = new Checks();
      mcpChecks(toRun(first), fs.readFileSync(ledgerFile, "utf8").trim().split("\n").map(JSON.parse), digest(value), checks);
      assert.equal(checks.outcome, "pass", checks.reason);
      assert.equal((await session.submit("LOCAL_MCP_RECALL", { timeoutMs: LOCAL_BUDGETS.turnMs })).answer, value);
    } finally {
      let receipt;
      try { if (session) receipt = await finishCLI(session); }
      finally {
        const apiReceipt = await local.close(); result.cleanup.receipts.push(apiReceipt); result.cleanup.ok &&= apiReceipt.ok;
      }
      if (session) assert.ok(normalExit(receipt), "MCP native exit/cleanup failed");
    }
  });
  await check("isolation", () => {
    result.isolation = [];
    for (const { options, inputs, sessions } of isolated.values()) {
      const values = inputs.flatMap(input => [...input.matchAll(/LOCAL_NONCE=([A-Za-z0-9_-]+)/g)].map(m => m[1]));
      const evidence = configEvidence(options, values, sessions, inputs);
      result.isolation.push({ configDir: options.configDir, ...evidence });
      assert.ok(evidence.ok, `${options.configDir}: ${evidence.reason}`);
    }
  });
  const requirements = { V01: ["print", "native", "unicode-picker-clear", "native-cleanup"], V02: ["print", "coding"],
    V03: ["mcp"], V04: ["native", "model-effort", "native-cleanup"], V05: ["native", "interrupt", "native-cleanup"],
    V06: ["native", "compact-resume", "native-cleanup"] };
  for (const [id, keys] of Object.entries(requirements)) {
    const missing = [...keys, "isolation", ...(id === "V02" ? [] : ["startup-repetitions"])].filter(key => !result.checks[key]?.ok);
    result.scenarios[id] = { ok: !missing.length && result.cleanup.ok,
      reason: missing.map(key => `${key}: ${result.checks[key]?.reason ?? "not exercised"}`).join("; ") || (result.cleanup.ok ? "" : "local cleanup failed") };
  }
  result.ok = Object.values(result.scenarios).every(s => s.ok);
  write(path.join(directory, "preflight.json"), result);
  if (result.cleanup.ok) fs.rmSync(temp, { recursive: true, force: true });
  return result;
}
if (isEntryPoint(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Provide a new explicit local preflight directory");
  const out = await preflightCLI({ claudeBin: resolveClaudeBin(), directory: path.resolve(dir) });
  console.log(JSON.stringify(out, null, 2)); process.exitCode = out.ok ? 0 : 1;
}

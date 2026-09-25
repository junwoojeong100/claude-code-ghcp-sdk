/** Execute the six essential cases; re-evaluate the same saved facts for reports. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchModelFor } from "../../src/model-map.mjs";
import { runHeadless, sanitizeEnv } from "./session.mjs";
import { snapshotTree, digest, marker } from "./fixtures.mjs";
import { runProcess } from "./process.mjs";
import { SCENARIOS, PRIMARY_MODELS, phaseModel } from "./scenarios.mjs";
import { createTimeoutPolicy } from "./timeouts.mjs";
import { Checks, attachLog, logSize, readLog, toRun, phaseVerdict, workspaceCheck } from "./evidence.mjs";
import { allowedSource, codingChecks, compactVerdict, continuityChecks, clearChecks,
  interruptState, interruptVerdict, matchingRequests, mcpChecks, modelStateChecks, sessionId, tapReport } from "./scenario-checks.mjs";
export { phaseVerdict } from "./evidence.mjs";
export { tapReport } from "./scenario-checks.mjs";

const MCP_TOOL = "mcp__fixture__lookup";
const scoped = (items, prefix) => items.map(item => ({ ...item, name: `${prefix}: ${item.name}` }));
const now = ctx => (ctx.dependencies?.now ?? Date.now)();
const remaining = ctx => {
  if (ctx.signal?.aborted) throw new Error("Slot was aborted");
  const ms = ctx.deadline - now(ctx);
  if (ms <= 0) throw new Error("Slot deadline exceeded");
  return ms;
};
const rawRun = run => run ? { ...run, observedSessionId: sessionId(run) } : null;
const policyFor = (id, label, facts, model, run) => {
  const tools = id === "V02" ? ["Read", "Edit", "Bash"] : id === "V03" ? [MCP_TOOL] : [];
  const expectedErrorIds = id === "V02" ? run?.usesOf("Bash").slice(0, 1).map(u => u.id) ?? [] :
    id === "V03" && label === "lookup" ? run?.toolUses.filter(u => u.name === MCP_TOOL && u.input.key === "missing").map(u => u.id) ?? [] : [];
  return { tools, runtimeTools: id === "V03" && label === "recall" ? [] : tools,
    mcpServers: id === "V03" ? ["fixture"] : [], plugins: facts.preflight?.plugins,
    answerSha256: facts.answers?.[label], expectedErrorIds, model };
};

/** Recompute behavior from captured events, never from stored green/check booleans. */
export function evaluateStoredSlot(slot) {
  const checks = new Checks(), facts = slot?.evidence?.facts;
  const scenario = SCENARIOS.find(s => s.id === slot?.scenario);
  const phases = {}, runs = {};
  if (!facts || !scenario || !PRIMARY_MODELS.includes(slot.model)) {
    checks.add("saved facts", false, "known scenario/model and raw facts are required", true);
    return { outcome: checks.outcome, reason: checks.reason, checks: checks.items, evidence: { phases } };
  }
  const ctx = { model: slot.model, preflight: facts.preflight };
  for (const { id: label } of scenario.phases) {
    const run = runs[label] = toRun(facts.runs?.[label]);
    const expectedModel = phaseModel(scenario, label, slot.model);
    const policy = policyFor(scenario.id, label, facts, expectedModel, run);
    let phase;
    if (run && scenario.id === "V05" && label === "interrupt") phase = interruptVerdict(rawRun(run), facts.beforeEscape, facts.interruptRequestId, ctx, policy, facts);
    else if (run && scenario.id === "V06" && label === "compact") phase = compactVerdict(rawRun(run), ctx, policy);
    else {
      phase = phaseVerdict(label, run, ctx, policy);
      if (run) {
        const state = new Checks();
        phase.modelStates = modelStateChecks(run, expectedModel, state, scenario.id === "V04" && label === "target" ? slot.model === "claude-haiku-4.5" ? null : "high" : undefined);
        const combined = new Checks(); combined.items.push(...phase.checks, ...state.items);
        Object.assign(phase, { checks: combined.items, outcome: combined.outcome, reason: combined.reason });
      }
    }
    if (!["interrupt", "compact"].includes(label)) {
      const expected = facts.answers?.[label];
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
        const missing = new Checks(); missing.items.push(...phase.checks);
        missing.add("expected answer recorded", false, "missing exact-answer digest", true);
        Object.assign(phase, { checks: missing.items, outcome: missing.outcome, reason: missing.reason });
      }
    }
    phase.policy = policy;
    phases[label] = phase;
    checks.items.push(...scoped(phase.checks, label));
  }
  checks.add("scenario execution", !facts.error, facts.error ?? "", Boolean(facts.error));
  const expectedLaunches = ["V01", "V06"].includes(scenario.id) ? 2 : 1;
  checks.add("CLI cleanup", Array.isArray(facts.launches) && facts.launches.length === expectedLaunches &&
    facts.launches.every(l => l?.ok === true && l.groupGone === true && l.exitCode === 0 && l.signal == null),
  "expected CLI processes must exit normally and all owned groups must be reaped",
  (!facts.launches || facts.launches.length < expectedLaunches || facts.launches.some(l => l?.ok == null)) &&
    !facts.launches?.some(l => l?.ok === false || l?.groupGone === false || (l?.exitCode != null && l.exitCode !== 0) || l?.signal != null));
  checks.add("private configuration isolation", facts.isolation?.ok === true, facts.isolation?.reason ?? "missing config snapshot", !facts.isolation);
  checks.add("launch settings integrity", facts.settings?.ok === true, "launch files changed or evidence missing", !facts.settings);
  if (facts.before && facts.after) {
    const source = scenario.id === "V02" && allowedSource(facts.source, facts.fixture) ? digest(facts.source) : null;
    workspaceCheck(facts.before, facts.after, source ? facts.fixture.sourceFile : null, source, checks);
  } else checks.add("workspace invariants", false, "missing before/after snapshot", true);

  const have = (...labels) => labels.every(label => runs[label]);
  switch (scenario.id) {
    case "V01": {
      const picker = facts.picker;
      checks.add("six-model native picker", Array.isArray(picker?.models) && PRIMARY_MODELS.every(m => picker.models.includes(m)) && picker.current === slot.model,
        "all six target entries and the selected model are required", !picker);
      if (have("unicode", "clear")) clearChecks(runs.unicode, runs.clear, facts.seedHash, checks);
      break;
    }
    case "V02": {
      if (runs.coding && facts.fixture) {
        const coding = codingChecks(runs.coding, { fixture: facts.fixture, workspace: facts.workspace }, checks);
        checks.add("edited source matches disk", coding.source != null && coding.source === facts.source, "Edit and final source disagree");
        const independent = facts.independent;
        checks.add("independent tests", independent?.completed === true && independent.status === 0 && independent.signal == null && !independent.error &&
          !independent.timedOut && !independent.aborted && !independent.stdoutTruncated && !independent.stderrTruncated && tapReport(independent.stdout, facts.fixture).ok,
        "independent process must complete with all three tests passing", !independent);
      } else checks.add("coding facts", false, "missing coding events/fixture", true);
      break;
    }
    case "V03":
      checks.add("same MCP value recalled", Boolean(facts.answers?.lookup) && facts.answers.lookup === facts.answers.recall,
        "lookup and recall must use the same expected value", !facts.answers?.lookup || !facts.answers?.recall);
      if (runs.lookup) mcpChecks(runs.lookup, facts.mcpLedger ?? [], facts.answers?.lookup, checks);
      if (have("lookup", "recall")) continuityChecks(runs.lookup, runs.recall, checks);
      break;
    case "V04":
      if (have("source", "target")) {
        continuityChecks(runs.source, runs.target, checks);
        checks.add("native model command", facts.commands?.some(c => c.text === `/model ${launchModelFor(slot.model)}`), "model switch command missing", !facts.commands);
        checks.add("native effort command", slot.model === "claude-haiku-4.5" || facts.commands?.some(c => c.text === "/effort high"), "high effort command missing", !facts.commands);
        checks.add("target retains source conversation", matchingRequests(runs.target).some(r => r.userTextHashes?.includes(facts.seedHash)), "seed prompt absent after switch", !matchingRequests(runs.target).length);
      }
      break;
    case "V05": {
      if (have("interrupt", "recovery")) continuityChecks(runs.interrupt, runs.recovery, checks);
      const t = facts.interruptTiming;
      checks.add("recovery after settled acknowledged interruption", phases.interrupt.outcome === "pass" && !facts.cleanupEscape &&
        Number.isFinite(t?.recoveryStartedAt) && t.recoveryStartedAt >= Math.max(t.settledAt, t.readyAt, t.ackAt) &&
        t.recoveryTurnDeadline <= t.recoveryDeadline && t.recoveryTurnDeadline <= t.recoveryStartedAt + t.budgets.recoveryMs &&
        t.recoveryStartedAt < t.recoveryTurnDeadline && t.recoverySettledAt >= t.recoveryStartedAt && t.recoverySettledAt <= t.recoveryTurnDeadline,
      "recovery requires a settled observer, native ready prompt, SDK acknowledgment and its reserved budget", !runs.recovery || t?.recoveryStartedAt == null);
      break;
    }
    case "V06":
      checks.add("same conversation value recalled", typeof facts.recallValue === "string" && facts.recallValue.length > 0 &&
        facts.answers?.recall === digest(facts.recallValue) && facts.answers?.resume === digest(facts.recallValue),
      "both recall phases must use the original conversation-only value", !facts.recallValue);
      if (have("seed", "compact", "recall", "resume")) {
        continuityChecks(runs.seed, runs.recall, checks);
        // After /compact the bridge must drop the SDK session that still holds the
        // uncompacted seed; its value is in both histories, so the answer cannot tell.
        const sdkSessions = run => (run.observations ?? []).filter(r => r.event === "bridge.verify_model_state").map(r => r.sessionId);
        const stale = [...sdkSessions(runs.seed), ...sdkSessions(runs.compact)], fresh = sdkSessions(runs.recall);
        const reused = fresh.some(id => id != null && stale.includes(id));
        checks.add("fresh SDK session after compact", stale.length > 0 && fresh.length > 0 && [...stale, ...fresh].every(id => typeof id === "string" && id) && !reused,
          "post-compact recall must be served by a new SDK session, not the pre-compaction one", !reused);
        const sent = run => (run.observations ?? []).filter(r => r.event === "bridge.verify_request");
        const seeded = sent(runs.seed), recalled = sent(runs.recall), carried = recalled.some(r => r.userTextHashes?.includes(facts.seedHash));
        checks.add("compacted history sent after compact", seeded.some(r => r.userTextHashes?.includes(facts.seedHash)) &&
          recalled.length > 0 && recalled.every(r => Array.isArray(r.userTextHashes)) && !carried,
        "seed prompt must reach the seed request and be absent from every post-compact recall request",
        !carried && (typeof facts.seedHash !== "string" || !seeded.length || !recalled.length || recalled.some(r => !Array.isArray(r.userTextHashes))));
        const restart = facts.restart;
        checks.add("cold bridge restart", restart?.cleanup?.ok === true && Number.isInteger(restart.beforePid) && Number.isInteger(restart.afterPid) && restart.beforePid !== restart.afterPid,
          "owned old bridge must be gone before replacement", !restart);
        checks.add("exact session cold resume", Boolean(sessionId(runs.seed)) && sessionId(runs.seed) === sessionId(runs.resume) &&
          Number.isInteger(runs.resume.pid) && runs.seed.pid !== runs.resume.pid && facts.launches?.length === 2 && facts.launches[0].exitCode === 0,
          "new CLI must resume original session after clean exit");
        const boundaries = runs.compact.events.filter(e => e.type === "system" && e.subtype === "compact_boundary");
        checks.add("resume includes saved compact boundary", boundaries.length === 1 && typeof boundaries[0].uuid === "string" &&
          facts.resumedHistory?.some(e => e.uuid === boundaries[0].uuid && e.subtype === "compact_boundary"), "saved boundary linkage missing", !facts.resumedHistory);
        const summaries = runs.compact.events.filter(e => e.isCompactSummary === true);
        checks.add("resume includes saved compact summary", summaries.length === 1 && facts.resumedHistory?.some(e =>
          e.isCompactSummary === true && e.uuid === summaries[0].uuid && e.parentUuid === summaries[0].parentUuid &&
          JSON.stringify(e.message) === JSON.stringify(summaries[0].message)), "saved summary content linkage missing", !facts.resumedHistory);
        checks.add("recall prompts do not disclose value", Array.isArray(facts.followupPrompts) && facts.followupPrompts.length === 2 &&
          facts.followupPrompts.every(p => !p.includes(facts.recallValue)), "value repeated in follow-up prompt", !facts.followupPrompts);
      }
      break;
  }
  const cleanupOk = facts.launches?.some(l => l?.ok === false) ? false :
    facts.launches?.length > 0 && facts.launches.every(l => l?.ok === true) ? true : null;
  const evidence = { ...slot.evidence, phases, cleanup: { ok: cleanupOk, launches: facts.launches ?? [] },
    isolation: facts.isolation ?? { ok: false, reason: "missing evidence" } };
  return { outcome: checks.outcome, reason: checks.reason, checks: checks.items, evidence };
}

export function configEvidence(ctx, values, sessionIds, inputs = []) {
  const snapshot = snapshotTree(ctx.configDir), bad = [];
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    // macOS registers a URL-handler link to the already pinned CLI binary.
    // Accept that exact metadata link only; never traverse links in the config.
    if (entry.type === "symlink" && name === "home/Applications/Claude Code URL Handler.app/Contents/MacOS/claude" &&
      typeof ctx.claudeBin === "string" && path.isAbsolute(ctx.claudeBin) && entry.target === ctx.claudeBin) continue;
    if (!["file", "directory"].includes(entry.type)) { bad.push(name); continue; }
    if (/(?:^|\/)(?:memory|memories|hooks|skills|agents)(?:\/|$)|(?:^|\/)CLAUDE\.md$/i.test(name) ||
      /^plugins\/(?:marketplaces|cache)(?:\/|$)/.test(name)) bad.push(name);
    if (entry.type === "file") {
      const content = fs.readFileSync(path.join(ctx.configDir, name));
      const transcript = /^projects\/[^/]+\/[^/]+\.jsonl$/.test(name) && sessionIds.has(path.basename(name, ".jsonl"));
      // Native input history is not a memory side channel: allow only submitted
      // inputs for this workspace and owned session IDs, never arbitrary records.
      let history = false;
      if (name === "history.jsonl") {
        try {
          const rows = content.toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
          history = rows.every(row => sessionIds.has(row.sessionId) && row.project === ctx.workspace &&
            inputs.includes(row.display) && row.pastedContents && Object.keys(row.pastedContents).length === 0 &&
            Object.keys(row).every(key => ["display", "pastedContents", "timestamp", "project", "sessionId"].includes(key)));
          if (!history) bad.push(name);
        } catch { bad.push(name); }
      }
      if (!transcript && !history && values.some(v => v && content.includes(Buffer.from(v)))) bad.push(name);
    }
  }
  return { ok: !snapshot.errors.length && !bad.length, reason: [...new Set(bad), ...snapshot.errors].join(", "), snapshot };
}

async function drive(ctx) {
  ctx = { ...ctx, deadline: ctx.deadline ?? now(ctx) + ctx.timeoutSeconds * 1000 };
  const facts = { workspace: ctx.workspace, fixture: ctx.fixture, preflight: ctx.preflight, before: snapshotTree(ctx.workspace),
    runs: {}, answers: {}, launches: [], commands: [], settings: null };
  const settings = new Map(), sessions = new Set(), secrets = [], inputs = ["/exit"];
  const rememberSettings = () => settings.set(ctx.settingsPath, digest(fs.readFileSync(ctx.settingsPath)));
  rememberSettings();
  let native;
  const dependencies = ctx.dependencies ?? {};
  const print = async (label, prompt, tools = []) => {
    const id = crypto.randomUUID(); sessions.add(id);
    const home = path.join(ctx.slotDir, "home"), tmp = path.join(ctx.slotDir, "tmp");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const { privateCLIEnv } = await import("./interactive.mjs");
    const start = logSize(ctx.bridge.logPath);
    const run = await (dependencies.runHeadless ?? runHeadless)({ prompt, cwd: ctx.workspace, settingsPath: ctx.settingsPath,
      frontendModel: ctx.frontendModel, configDir: ctx.configDir, claudeBin: ctx.claudeBin, timeoutSeconds: remaining(ctx) / 1000,
      signal: ctx.signal, env: {}, childEnv: privateCLIEnv({ home, configDir: ctx.configDir, tmpDir: tmp, env: process.env }),
      transcriptPath: path.join(ctx.slotDir, `transcript-${label}.jsonl`),
      extraArgs: ["--restricted", "--permission-mode", "dontAsk", "--tools", tools.join(","), "--session-id", id,
        ...(tools.length ? ["--allowedTools", "Read", "Edit", `Bash(${ctx.fixture.testCommand.join(" ")})`] : [])] });
    await attachLog(run, ctx.bridge.logPath, start);
    facts.runs[label] = rawRun(run); facts.launches.push(run.cleanup ?? { ok: null, reason: "print cleanup receipt missing" });
    return run;
  };
  const launch = async (options = {}) => {
    const Type = dependencies.InteractiveSession ?? (await import("./interactive.mjs")).InteractiveSession;
    native = new Type({ claudeBin: ctx.claudeBin, workspace: ctx.workspace, configDir: ctx.configDir, settingsPath: ctx.settingsPath,
      frontendModel: ctx.frontendModel, slotDir: ctx.slotDir, sessionId: options.sessionId ?? crypto.randomUUID(),
      tools: options.tools ?? [], mcpConfig: options.mcpConfig ?? { mcpServers: {} }, timeoutMs: remaining(ctx), signal: ctx.signal });
    await native.start({ resume: options.resume ?? false });
    if (native.sessionId) sessions.add(native.sessionId);
  };
  const submit = async (label, prompt, { timeoutMs = remaining(ctx) } = {}) => {
    inputs.push(prompt);
    const start = logSize(ctx.bridge.logPath);
    let result, failure;
    try { result = await native.submit(prompt, { timeoutMs: Math.min(timeoutMs, remaining(ctx)) }); }
    catch (error) { result = error.result; failure = error; }
    if (result) {
      const run = await attachLog(toRun(result), ctx.bridge.logPath, start);
      sessions.add(sessionId(run)); facts.runs[label] = rawRun(run);
      if (!failure) return run;
    }
    throw failure ?? new Error("Native turn returned no evidence");
  };
  const command = async text => {
    inputs.push(text);
    const start = logSize(ctx.bridge.logPath);
    facts.commands.push({ text, sessionId: native.sessionId });
    try { return { result: await native.command(text, { timeoutMs: remaining(ctx) }), start }; }
    catch (error) {
      if (text === "/compact" && error.result) {
        facts.runs.compact = rawRun(await attachLog(toRun(error.result), ctx.bridge.logPath, start));
      }
      throw error;
    }
  };
  const close = async () => {
    if (!native) return null;
    const closing = native; native = null;
    const receipt = await closing.close(); facts.launches.push(receipt);
    inputs.push(...closing.inputs ?? []);
    return receipt;
  };
  const expect = (label, value) => { facts.answers[label] = digest(value); };
  const phase = id => native?.markPhase?.(id);
  try {
    switch (ctx.scenario.id) {
      case "V01": {
        const printValue = marker(), nonce = marker(), unicode = `${marker()} 안녕 café`, fresh = marker(); secrets.push(nonce);
        expect("print", printValue); expect("unicode", unicode); expect("clear", fresh);
        await print("print", `Reply with exactly ${printValue}. No tools or other text.`);
        await launch(); phase("unicode");
        const opened = await command("/model");
        facts.picker = opened.result?.picker ?? null;
        facts.pickerScreen = native.screen();
        await native.escape({ purpose: "picker-dismiss" });
        const seed = `Remember the inert project label ${nonce} in this conversation only. Do not write it to files or memory. Do not use tools. Reply with only the exact literal on the final line below, without quotes, punctuation, or any other text.\n${unicode}`;
        facts.seedHash = digest(seed);
        await submit("unicode", seed);
        phase("clear");
        await command("/clear");
        if (native.sessionId) sessions.add(native.sessionId);
        await submit("clear", `If you know the project label from this conversation reply with it; otherwise reply with exactly ${fresh}. Do not use tools. No other text.`);
        break;
      }
      case "V02": {
        const f = ctx.fixture; expect("coding", f.sample);
        const prompt = `Use Read to read all of ${f.sampleFile}, ${f.sourceFile}, and ${f.testFile}, without offset or limit. Run exactly ${f.testCommand.join(" ")} using foreground Bash to reproduce the failures. Then use Edit once to fix only the discount calculation in ${f.sourceFile}, leaving every other byte and all other files unchanged. After the Edit succeeds, run the identical foreground test command again. No chaining, redirection, background work, extra commands, files or tools. After all three tests pass, reply with only the exact sample.txt value on one line.`;
        const run = await print("coding", prompt, ["Read", "Edit", "Bash"]);
        const coding = codingChecks(run, ctx);
        const sourcePath = path.join(ctx.workspace, f.sourceFile);
        facts.source = fs.lstatSync(sourcePath).isFile() ? fs.readFileSync(sourcePath, "utf8") : null;
        const workspace = new Checks();
        const safeToTest = workspaceCheck(facts.before, snapshotTree(ctx.workspace),
          coding.source && allowedSource(coding.source, f) ? f.sourceFile : null,
          coding.source && allowedSource(coding.source, f) ? digest(coding.source) : null, workspace);
        if (coding.outcome === "pass" && facts.source === coding.source && safeToTest) {
          const out = await (dependencies.runProcess ?? runProcess)(process.execPath, f.testCommand.slice(1), { cwd: ctx.workspace,
            env: sanitizeEnv(), timeoutMs: Math.min(30000, remaining(ctx)), signal: ctx.signal });
          facts.independent = { ...out, error: out.error?.message ?? null };
        }
        break;
      }
      case "V03": {
        const value = marker(), dir = path.join(ctx.slotDir, "mcp"), ledger = path.join(dir, "ledger.jsonl"), file = path.join(dir, "value.txt");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, value, { mode: 0o600 });
        expect("lookup", value); expect("recall", value);
        await launch({ tools: [MCP_TOOL], mcpConfig: { mcpServers: { fixture: { type: "stdio", command: process.execPath,
          args: [fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url)), file, ledger] } } } });
        phase("lookup");
        await submit("lookup", 'Use only mcp__fixture__lookup. First call key "missing". After receiving ENOENT, call key "selected" once. Reply with only the exact returned synthetic value. Do not read files or use shell tools.');
        phase("recall");
        await submit("recall", "Without tools, repeat only the exact synthetic value returned by the earlier MCP lookup. No other text.");
        facts.mcpLedger = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(JSON.parse);
        break;
      }
      case "V04": {
        const value = marker(), acknowledgment = marker(); secrets.push(value);
        expect("source", acknowledgment); expect("target", value);
        await launch();
        const seed = `Remember this conversation-only value: ${value}. Do not use tools or write files. Reply with exactly ${acknowledgment}.`;
        facts.seedHash = digest(seed);
        phase("source");
        await submit("source", seed);
        phase("target");
        await command(`/model ${launchModelFor(ctx.model)}`);
        if (ctx.model !== "claude-haiku-4.5") await command("/effort high");
        await submit("target", "What was the conversation-only value from the preceding request? Reply with only that exact value. Do not use tools.");
        break;
      }
      case "V05": {
        const value = marker(); expect("recovery", value);
        const timeouts = ctx.timeouts ?? createTimeoutPolicy(SCENARIOS);
        const budgets = { ...timeouts.interrupt, cleanupMs: timeouts.cleanupMs };
        const timing = facts.interruptTiming = { budgets, slotDeadline: ctx.deadline,
          recoveryDeadline: ctx.deadline - budgets.cleanupMs,
          interruptDeadline: ctx.deadline - budgets.cleanupMs - budgets.recoveryMs };
        await launch();
        timing.startedAt = now(ctx);
        timing.progressDeadline = Math.min(timing.startedAt + budgets.progressMs, timing.interruptDeadline - budgets.settleMs);
        if (timing.progressDeadline <= timing.startedAt) {
          facts.interruptOutcome = "insufficient-phase-budget";
          throw new Error("No progress budget remains after reserving interruption, recovery and cleanup");
        }
        phase("interrupt");
        const start = logSize(ctx.bridge.logPath);
        const prompt = "Write the integers from 1 through 2000 in ascending order, one integer per line. Start with 1 immediately. No introduction, explanation, summary, code block, or tools.";
        inputs.push(prompt);
        const observer = new AbortController();
        const cancel = () => observer.abort(ctx.signal?.reason ?? new Error("Interrupt observation cancelled"));
        ctx.signal?.addEventListener("abort", cancel, { once: true });
        if (ctx.signal?.aborted) cancel();
        let settled = false, result, failure, log;
        // This observer is always awaited, including after AbortSignal cancellation.
        // No race leaves an active submit behind when recovery starts.
        const done = Promise.resolve().then(() => native.submit(prompt, {
          timeoutMs: timing.interruptDeadline - now(ctx), signal: observer.signal,
        })).then(r => { result = r; }, e => { result = e.result; failure = e; })
          .then(() => { settled = true; timing.settledAt = now(ctx); });
        const observe = () => {
          log = readLog(ctx.bridge.logPath, start);
          facts.interruptObservations = log.rows;
          const request = log.rows.find(r => r.event === "bridge.verify_request" && r.claudeAgent === "root" && r.claudeSessionId === native.sessionId);
          // Preserve the first request even if it never emits text or finishes too soon.
          if (request && !facts.interruptRequestId) {
            facts.interruptRequestId = request.requestId; timing.requestObservedAt = now(ctx);
          }
          return interruptState(log.rows, facts.interruptRequestId);
        };
        const pause = async deadline => {
          remaining(ctx);
          const ms = Math.min(25, deadline - now(ctx));
          if (ms > 0) await (dependencies.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(ms);
        };
        const stop = (outcome, message) => { facts.interruptOutcome = outcome; throw new Error(message); };
        try {
          let activity, state;
          while (now(ctx) < timing.progressDeadline) {
            state = observe();
            if (log.error) stop("observation-error", log.error);
            if (state.terminal.length || settled) stop(failure ? "native-observer-failed" : "completed-before-interrupt", failure?.message ?? "Turn ended before a test Escape could be sent");
            if (state.active) {
              activity = await native.activity();
              state = observe(); // Recheck after the native snapshot, immediately before Escape.
              if (!settled && state.active && activity.active === true && activity.interruptible === true && activity.ready === false) break;
            }
            await pause(timing.progressDeadline);
          }
          if (!state?.active || !activity?.active || !activity.interruptible || activity.ready !== false || settled || now(ctx) >= timing.progressDeadline) {
            stop(state?.progressIndex >= 0 ? "native-not-interruptible" : "no-text-progress", "No active root text stream and current native interruptible activity within the progress budget");
          }
          remaining(ctx);
          facts.beforeEscape = log.rows; facts.nativeBeforeEscape = activity;
          timing.escapeAt = now(ctx);
          timing.settleDeadline = Math.min(timing.escapeAt + budgets.settleMs, timing.interruptDeadline);
          try { facts.testEscape = await native.escape({ purpose: "test-interrupt", timeoutMs: timing.settleDeadline - now(ctx) }); }
          catch (error) { facts.testEscapeError = error.message; stop("native-receipt-missing", error.message); }
          if (facts.testEscape?.kind !== "escape" || facts.testEscape.purpose !== "test-interrupt" || facts.testEscape.accepted !== true) {
            stop("native-receipt-missing", "Test Escape did not return an accepted native input receipt");
          }
          while (now(ctx) < timing.settleDeadline) {
            state = observe();
            if (log.error) stop("observation-error", log.error);
            if (failure) stop("native-observer-failed", failure.message);
            if (state.ack.some(r => r.acknowledged !== true)) stop("abort-not-acknowledged", "SDK did not acknowledge the test interruption");
            if (state.terminal.some(r => r.event === "bridge.turn_completed")) stop("completed-before-interrupt", "The interrupted request completed normally");
            if (state.acknowledged && timing.ackAt == null) timing.ackAt = now(ctx);
            const activity = facts.nativeAfterInterrupt = await native.activity();
            if (settled && result?.interrupted !== true) stop("native-interruption-unconfirmed", "Native submit ended without actual interruption evidence");
            if (settled && result?.interruption?.ready === true && activity.ready === true && activity.active === false) {
              timing.readyAt ??= now(ctx);
              if (state.acknowledged && state.stopped) break;
            }
            await pause(timing.settleDeadline);
          }
          if (!settled || result?.interrupted !== true || timing.readyAt == null) stop("native-interruption-unconfirmed", "Native interruption and ready prompt did not settle within the phase budget");
          if (!state.acknowledged || !state.stopped || now(ctx) >= timing.settleDeadline) stop("abort-ack-missing", "Correlated SDK abort and interrupted transport did not settle within the phase budget");
          facts.interruptOutcome = "interrupted";
        } catch (error) {
          facts.interruptOutcome ??= "native-observer-failed";
          throw error;
        } finally {
          if (!settled) { timing.observerCancelled = true; observer.abort(new Error("Interrupt phase ended")); }
          await done;
          ctx.signal?.removeEventListener("abort", cancel);
          observe();
          facts.runs.interrupt = rawRun(toRun({ ...(result ?? { events: [], nativeTurn: false, pid: native.pid, sessionId: native.sessionId }),
            observations: log.rows, sdkRecords: log.rows.filter(r => r.event === "bridge.turn_completed"), sdkLogRange: log.range, sdkLogError: log.error }));
          sessions.add(sessionId(facts.runs.interrupt));
          // Failure cleanup has its own purpose and can never establish test success.
          if (facts.interruptOutcome !== "interrupted") {
            try {
              if ((await native.activity()).active) facts.cleanupEscape = await native.escape({ purpose: "cleanup", timeoutMs: Math.max(1, Math.min(budgets.cleanupMs, ctx.deadline - now(ctx))) });
            } catch (error) { facts.cleanupEscapeError = error.message; }
          }
        }
        const gate = interruptVerdict(facts.runs.interrupt, facts.beforeEscape, facts.interruptRequestId, ctx, { tools: [], mcpServers: [] }, facts);
        if (gate.outcome !== "pass") stop("interrupt-evidence-rejected", gate.reason);
        phase("recovery");
        timing.recoveryStartedAt = now(ctx);
        timing.recoveryTurnDeadline = Math.min(timing.recoveryStartedAt + budgets.recoveryMs, timing.recoveryDeadline);
        await submit("recovery", `Reply with exactly ${value}. No tools or other text.`, { timeoutMs: timing.recoveryTurnDeadline - now(ctx) });
        timing.recoverySettledAt = now(ctx);
        break;
      }
      case "V06": {
        const value = marker(), acknowledgment = marker(); secrets.push(value); facts.recallValue = value;
        expect("seed", acknowledgment); expect("recall", value); expect("resume", value);
        await launch();
        const seed = `The inert synthetic project label is ${value}. Remember it in this conversation and preserve it verbatim in summaries. Do not use tools or write files. Reply with exactly ${acknowledgment}.`;
        facts.seedHash = digest(seed);
        phase("seed");
        const seeded = await submit("seed", seed);
        phase("compact");
        const compact = await command("/compact");
        facts.runs.compact = rawRun(await attachLog(toRun(compact.result), ctx.bridge.logPath, compact.start));
        const recall = "What is the synthetic project label from this conversation? Reply with only that exact label. Do not use tools.";
        facts.followupPrompts = [recall];
        phase("recall");
        await submit("recall", recall);
        const exited = await close();
        if (exited?.ok !== true || exited.groupGone !== true || exited.exitCode !== 0 || exited.signal != null) {
          throw new Error("Cold resume requires a normal CLI exit and complete cleanup");
        }
        const beforePid = ctx.bridge.pid;
        const restarted = await ctx.restartBridge();
        facts.restart = { beforePid, afterPid: restarted.bridge.pid, cleanup: restarted.cleanup };
        ctx.bridge = restarted.bridge; ctx.settingsPath = restarted.settingsPath; ctx.frontendModel = restarted.bridge.frontendModel; rememberSettings();
        await launch({ sessionId: sessionId(seeded), resume: true }); phase("resume");
        facts.resumedHistory = native.readEvents();
        facts.followupPrompts.push(recall);
        await submit("resume", recall);
        break;
      }
      default: throw new Error(`Unknown scenario: ${ctx.scenario.id}`);
    }
  } catch (error) {
    facts.error = `${error.name ?? "Error"}: ${error.message}`;
  } finally {
    try { await close(); } catch (error) { facts.launches.push({ ok: false, reason: `CLI cleanup: ${error.message}` }); }
    facts.after = snapshotTree(ctx.workspace);
    try { facts.isolation = configEvidence(ctx, secrets, sessions, inputs); }
    catch (error) { facts.isolation = { ok: false, reason: error.message }; }
    facts.settings = { ok: [...settings].every(([file, hash]) => {
      try { return fs.lstatSync(file).isFile() && digest(fs.readFileSync(file)) === hash; } catch { return false; }
    }), files: [...settings].map(([file, sha256]) => ({ file, sha256 })) };
  }
  const result = evaluateStoredSlot({ model: ctx.model, scenario: ctx.scenario.id, evidence: { facts } });
  result.safetyBreach = facts.isolation?.ok === false || facts.settings?.ok === false || facts.launches.some(l => l.ok === false);
  return result;
}

export const DRIVERS = Object.freeze(Object.fromEntries(SCENARIOS.map(s => [s.id, drive])));

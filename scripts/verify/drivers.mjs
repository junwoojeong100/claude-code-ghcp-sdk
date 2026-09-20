/**
 * One driver per scenario.
 *
 * A driver composes the prompt, runs the headless session, and judges the
 * outcome from primary evidence: files on disk, git history, hook logs, and
 * the stream's own record of which tools ran. Model prose is only ever checked
 * for a specific planted token -- never for style, structure, or agreement.
 *
 * Outcomes:
 *   pass    every check held
 *   fail    a check did not hold, and the run completed well enough to judge
 *   blocked the run could not be judged (timeout, crash, bad wire protocol)
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { runHeadless, servedExpectedModel } from "./session.mjs";
import { exists, gitLogSubjects, readIfPresent } from "./fixtures.mjs";
import { ROOT_DIR } from "./bridge.mjs";

/* ------------------------------------------------------------------ *
 * Check plumbing
 * ------------------------------------------------------------------ */

class Checks {
  constructor() {
    this.items = [];
  }
  add(name, ok, detail = "") {
    this.items.push({ name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  }
  get failed() {
    return this.items.filter((item) => !item.ok);
  }
  get ok() {
    return this.failed.length === 0;
  }
  summary() {
    return this.failed.map((item) => `${item.name}: ${item.detail || "not satisfied"}`).join("; ");
  }
}

/**
 * Wire-level guarantees asserted on every slot.
 *
 * These are the things that would make the scenario's own checks meaningless
 * if they were broken, so a failure here is `blocked`, not `fail`.
 */
function transportVerdict(run, ctx) {
  if (!run.completed) {
    return { blocked: true, reason: run.failureHint ?? "run did not complete" };
  }
  const pairing = run.pairingReport();
  if (!pairing.ok) {
    return {
      blocked: true,
      reason: `tool_use/tool_result mismatch (unanswered: ${pairing.unanswered.join(", ") || "none"}, orphaned: ${pairing.orphaned.length})`,
    };
  }
  const served = servedExpectedModel(run, ctx);
  if (!served.ok) {
    return { blocked: true, reason: served.reason };
  }
  return { blocked: false, served: served.served };
}

function envelopeChecks(checks, run) {
  const result = run.result;
  checks.add("result.stop_reason present", Boolean(result?.stop_reason ?? result?.subtype), String(result?.stop_reason ?? result?.subtype ?? "missing"));
  checks.add("usage reports input tokens", run.inputTokens > 0, `input=${run.inputTokens}`);
  checks.add("no error in result envelope", result?.is_error !== true, String(result?.result ?? "").slice(0, 160));
}

const normalise = (value) => String(value ?? "").replace(/[\s,_]+/g, "").toLowerCase();

function mentions(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

function sha(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Every scenario needs to write files and run commands, and there is no human
 * to approve either. Slots run in throwaway directories, so the permission
 * prompt has nothing to protect here -- without this the run measures the
 * prompt, not the model.
 *
 * Hooks still fire in this mode, which is what v08 depends on.
 */
const PERMISSION_ARGS = ["--permission-mode", "bypassPermissions"];

async function run1(ctx, prompt, { extraArgs = [], label = "main" } = {}) {
  return runHeadless({
    prompt,
    cwd: ctx.workspace,
    settingsPath: ctx.settingsPath,
    frontendModel: ctx.frontendModel,
    configDir: ctx.configDir,
    claudeBin: ctx.claudeBin,
    timeoutSeconds: ctx.timeoutSeconds,
    transcriptPath: path.join(ctx.slotDir, `transcript-${label}.jsonl`),
    extraArgs: [...PERMISSION_ARGS, ...extraArgs],
  });
}

function verdict(checks, run, ctx, evidence = {}) {
  const transport = transportVerdict(run, ctx);
  if (transport.blocked) {
    return {
      outcome: "blocked",
      reason: transport.reason,
      checks: checks.items,
      evidence: { ...evidence, tools: run.toolNames(), durationMs: run.durationMs },
    };
  }
  envelopeChecks(checks, run);
  return {
    outcome: checks.ok ? "pass" : "fail",
    reason: checks.ok ? "" : checks.summary(),
    checks: checks.items,
    evidence: {
      ...evidence,
      tools: run.toolNames(),
      servedModels: transport.served,
      durationMs: run.durationMs,
      inputTokens: run.inputTokens,
      answer: run.answer.slice(0, 600),
    },
  };
}

/* ------------------------------------------------------------------ *
 * v01 -- repository reconnaissance
 * ------------------------------------------------------------------ */

async function driveRepoRecon(ctx) {
  const { fixture } = ctx;
  const run = await run1(
    ctx,
    "This repository applies a spread when settlements cross a clearing window. " +
      "Find the file that DEFINES the constant holding that spread. " +
      "Reply with exactly two lines: the relative path on the first line, and the constant's numeric value on the second. No other text.",
  );

  const checks = new Checks();
  const answer = run.answer;

  checks.add(
    "a search tool was used",
    run.usedTool("Glob", "Grep", "Bash", "Task"),
    `tools: ${run.toolNames().join(", ") || "none"}`,
  );
  checks.add("names the defining file", answer.includes(fixture.needleFile), answer.slice(0, 200));
  checks.add("reports the constant's value", mentions(answer, fixture.needleValue), answer.slice(0, 200));
  const citedDecoy = fixture.decoys.filter((decoy) => answer.includes(decoy));
  checks.add("does not cite a decoy as the definition", citedDecoy.length === 0, citedDecoy.join(", "));

  return verdict(checks, run, ctx, { needle: fixture.needleFile });
}

/* ------------------------------------------------------------------ *
 * v02 -- surgical edit
 * ------------------------------------------------------------------ */

async function driveSurgicalEdit(ctx) {
  const { fixture, workspace } = ctx;
  const run = await run1(
    ctx,
    `In ${fixture.targetFile}, change ${fixture.targetKey} to ${fixture.newValue}. ` +
      "Leave every other retry budget exactly as it is. " +
      `Then create ${fixture.newFile} exporting a const named ${fixture.newExport} — an object with a requestMs property set to 30000.`,
  );

  const checks = new Checks();
  const edited = readIfPresent(workspace, fixture.targetFile) ?? "";
  const created = readIfPresent(workspace, fixture.newFile);

  checks.add(
    "target value changed",
    new RegExp(`${fixture.targetKey}\\s*:\\s*${fixture.newValue}\\b`).test(edited),
    edited.slice(0, 240),
  );
  for (const line of fixture.untouched) {
    checks.add(`untouched: ${line.trim()}`, edited.includes(line), "line was altered or removed");
  }
  checks.add("new file created", created !== null, fixture.newFile);
  checks.add(
    "new file exports the requested const",
    created !== null && new RegExp(`export\\s+const\\s+${fixture.newExport}\\b`).test(created),
    (created ?? "").slice(0, 200),
  );
  checks.add(
    "used Edit rather than rewriting the file",
    run.usedTool("Edit", "MultiEdit", "NotebookEdit"),
    `tools: ${run.toolNames().join(", ")}`,
  );

  return verdict(checks, run, ctx);
}

/* ------------------------------------------------------------------ *
 * v03 -- failing test loop
 * ------------------------------------------------------------------ */

async function driveTestFixLoop(ctx) {
  const { fixture, workspace } = ctx;
  const testPath = path.join(workspace, fixture.testFile);
  const before = sha(testPath);

  const run = await run1(
    ctx,
    `Run \`node --test ${fixture.testFile}\`. One test fails. ` +
      "Diagnose it, fix the source so the whole suite passes, and re-run to confirm. " +
      "The test file states the requirement correctly — do not modify anything under test/.",
  );

  const checks = new Checks();
  checks.add("Bash was used to run the suite", run.usedTool("Bash"), `tools: ${run.toolNames().join(", ")}`);

  const sawFailure = run.toolResults.some(
    (result) => /not ok|fail|AssertionError/i.test(result.content) || result.isError,
  );
  checks.add("saw the failing run and kept going", sawFailure && run.toolUses.length > 1, `tool calls: ${run.toolUses.length}`);
  checks.add("test file untouched", sha(testPath) === before, "test/ was modified");

  // The decisive check: the harness runs the suite itself.
  const rerun = spawnSync("node", ["--test", fixture.testFile], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 60_000,
  });
  checks.add(
    "suite passes on an independent re-run",
    rerun.status === 0,
    (rerun.stdout ?? "").split("\n").filter((l) => /^# (fail|pass)/.test(l)).join(" "),
  );

  return verdict(checks, run, ctx, { rerunExit: rerun.status });
}

/* ------------------------------------------------------------------ *
 * v04 -- background shell and git
 * ------------------------------------------------------------------ */

/**
 * The fixture names its script for this slot, so the basename is a pattern no
 * other slot can match. Matching on the workspace path instead would never
 * fire: the model starts the script from inside the workspace, so its command
 * line carries a relative name and nothing absolute to match against.
 */
function countTickerProcesses(tickerScript) {
  const result = spawnSync("pgrep", ["-f", tickerScript], { encoding: "utf8" });
  return (result.stdout ?? "").trim().split("\n").filter(Boolean).length;
}

async function driveShellOps(ctx) {
  const { fixture, workspace } = ctx;
  const run = await run1(
    ctx,
    `Start \`node ${fixture.tickerScript} ${fixture.logFile}\` as a background process. ` +
      `Poll its output until ${fixture.logFile} holds at least ${fixture.minTicks} ticks, then stop that process. ` +
      `Write ${fixture.recordFile} containing the number of ticks recorded. ` +
      `Finally commit every change with exactly this message: ${fixture.commitSubject}`,
  );

  const checks = new Checks();
  // This build offers no BashOutput tool, so a long-running process is managed
  // either by backgrounding it or by watching the file it writes. Both are
  // legitimate; what matters is that the process ran and was then stopped.
  const bashUses = run.usesOf("Bash");
  const started = bashUses.some((use) =>
    String(use.input?.command ?? "").includes(fixture.tickerScript) ||
    use.input?.run_in_background === true,
  );
  checks.add(
    "started the long-running process",
    started,
    `bash calls: ${bashUses.length}, tools: ${run.toolNames().join(", ")}`,
  );
  checks.add(
    "watched it until the log filled",
    bashUses.some((u) => String(u.input?.command ?? "").includes(fixture.logFile)) ||
      run.usedTool("Read"),
    "no evidence the log was read",
  );

  const ticks = (readIfPresent(workspace, fixture.logFile) ?? "").trim().split("\n").filter(Boolean);
  checks.add(`log reached ${fixture.minTicks} ticks`, ticks.length >= fixture.minTicks, `ticks=${ticks.length}`);
  checks.add("record file written", exists(workspace, fixture.recordFile), fixture.recordFile);

  const subjects = gitLogSubjects(workspace);
  checks.add(
    "commit made with the exact subject",
    subjects.includes(fixture.commitSubject),
    `log: ${subjects.slice(0, 3).join(" | ")}`,
  );

  const survivors = countTickerProcesses(fixture.tickerScript);
  checks.add("no ticker process survives", survivors === 0, `survivors=${survivors}`);

  return verdict(checks, run, ctx, { ticks: ticks.length, subjects: subjects.slice(0, 3) });
}

/* ------------------------------------------------------------------ *
 * v05 -- tracked multi-step execution
 * ------------------------------------------------------------------ */

async function driveMultiStep(ctx) {
  const { fixture, workspace } = ctx;
  const run = await run1(
    ctx,
    "Four changes, please. Complete all four:\n" +
      '1. In src/greet.mjs, change the greeting text from "Hello" to "Good morning".\n' +
      "2. Bump the VERSION file to 0.2.0.\n" +
      `3. Create CHANGELOG.md whose first entry mentions the release token ${fixture.token}.\n` +
      `4. In ${fixture.notebookFile}, change RATE from 0.05 to ${fixture.newRate}.\n` +
      "Then tell me which of the four you completed.",
  );

  const checks = new Checks();

  for (const step of fixture.steps) {
    const content = readIfPresent(workspace, step.file);
    checks.add(
      `${step.file} carries "${step.expect}"`,
      content !== null && mentions(content, step.expect),
      content === null ? "file missing" : content.slice(0, 120),
    );
  }

  // The notebook must survive as a notebook. A model that rewrites it as plain
  // text can still satisfy the string check above, so parse it back.
  const raw = readIfPresent(workspace, fixture.notebookFile);
  let notebookOk = false;
  let notebookNote = "unreadable";
  if (raw !== null) {
    try {
      const nb = JSON.parse(raw);
      const cells = Array.isArray(nb.cells) ? nb.cells : [];
      const rateCell = cells.find((cell) =>
        String(Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "")).includes("RATE"),
      );
      notebookOk =
        nb.nbformat === 4 &&
        cells.length >= 2 &&
        rateCell !== undefined &&
        String(Array.isArray(rateCell.source) ? rateCell.source.join("") : rateCell.source).includes(fixture.newRate);
      notebookNote = `nbformat=${nb.nbformat} cells=${cells.length}`;
    } catch (error) {
      notebookNote = `not JSON: ${String(error.message).slice(0, 80)}`;
    }
  }
  checks.add("notebook is still a valid nbformat 4 document", notebookOk, notebookNote);

  // A claim of completion with nothing on disk is the failure this catches.
  const landed = fixture.steps.filter((step) => {
    const content = readIfPresent(workspace, step.file);
    return content !== null && mentions(content, step.expect);
  }).length;
  checks.add(
    "no step was claimed without the file backing it",
    !/\ball four\b|\bcompleted all\b/i.test(run.answer) || landed === fixture.steps.length,
    `landed ${landed}/${fixture.steps.length}`,
  );

  return verdict(checks, run, ctx, { landed, steps: fixture.steps.length });
}

/* ------------------------------------------------------------------ *
 * v06 -- subagent delegation
 * ------------------------------------------------------------------ */

async function driveSubagent(ctx) {
  const { fixture } = ctx;
  const run = await run1(
    ctx,
    `Use the ${fixture.agentName} subagent to find every file containing the marker ${fixture.marker}. ` +
      "Then report how many files carry it, and list their paths.",
    { extraArgs: ["--setting-sources", "project,local"] },
  );

  const checks = new Checks();
  const advertised = JSON.stringify(run.init?.agents ?? []);
  checks.add(
    "project agent is advertised",
    advertised.includes(fixture.agentName),
    advertised.slice(0, 200),
  );

  // init advertises this tool as "Task", but the invocable name is "Agent".
  // Accept either so the check follows the build rather than the label.
  const delegations = [...run.usesOf("Agent"), ...run.usesOf("Task")];
  checks.add("delegation tool was invoked", delegations.length > 0, `tools: ${run.toolNames().join(", ")}`);
  checks.add(
    "delegated to the named agent",
    delegations.some((use) => String(use.input?.subagent_type ?? "").includes(fixture.agentName)),
    delegations.map((u) => u.input?.subagent_type).join(", "),
  );

  const delegationIds = new Set(delegations.map((use) => use.id));
  const returned = run.toolResults.filter((result) => delegationIds.has(result.id));
  checks.add("delegation returned a result", returned.length > 0 && returned.some((r) => !r.isError), `results: ${returned.length}`);

  const answer = run.answer;
  const found = fixture.carriers.filter((carrier) => answer.includes(carrier));
  checks.add(
    "reports every carrier the search would find",
    found.length === fixture.carriers.length,
    `named ${found.length}/${fixture.carriers.length}: ${found.join(", ")}`,
  );

  return verdict(checks, run, ctx, { carriers: fixture.carriers, delegations: delegations.length });
}

/* ------------------------------------------------------------------ *
 * v07 -- MCP browser automation
 * ------------------------------------------------------------------ */

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(rootDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      fs.readFile(filePath, (error, body) => {
        if (error) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function driveMcpPlaywright(ctx) {
  const { fixture, workspace, slotDir } = ctx;
  const server = await startStaticServer(path.join(workspace, "public"));
  const mcpConfigPath = path.join(slotDir, "mcp.json");

  // Chrome for Testing is not installed in this environment; the system Chrome
  // channel is. --isolated keeps the browser profile in memory so the slot
  // never touches a real one -- and it rejects --user-data-dir outright.
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          playwright: {
            command: process.execPath,
            args: [
              path.join(ROOT_DIR, "node_modules", "@playwright", "mcp", "cli.js"),
              "--browser", "chrome",
              "--headless",
              "--isolated",
              "--output-dir", path.join(slotDir, "playwright-out"),
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    const run = await run1(
      ctx,
      `Using the playwright browser tools, open ${server.url} and read the page. ` +
        "Reply with only the build token shown on that page.",
      { extraArgs: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"] },
    );

    const checks = new Checks();
    const servers = run.mcpServers;
    const playwright = servers.find((entry) => String(entry.name).includes("playwright"));
    checks.add(
      "playwright MCP server connected",
      playwright?.status === "connected",
      JSON.stringify(servers).slice(0, 200),
    );

    const mcpCalls = run.toolUses.filter((use) => /^mcp__playwright__/.test(String(use.name)));
    checks.add("an MCP browser tool was called", mcpCalls.length > 0, `tools: ${run.toolNames().join(", ")}`);
    checks.add(
      "reports the token that exists only in the page",
      mentions(run.answer, fixture.pageToken),
      run.answer.slice(0, 200),
    );

    return verdict(checks, run, ctx, {
      mcpTools: mcpCalls.map((c) => c.name).slice(0, 6),
      pageUrl: server.url,
    });
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------------ *
 * v08 -- hooks, memory, commands, skills
 * ------------------------------------------------------------------ */

async function driveHooksMemory(ctx) {
  const { fixture, workspace } = ctx;
  const suggestedPath = "docs/audit-latest.md";
  // The prompt deliberately names the wrong path: the project's own conventions
  // have to win, and the model can only learn them by reading CLAUDE.md. What
  // the prompt must NOT do is leave "stop and ask which one you meant" open as
  // a reading -- a model that pauses for confirmation writes nothing, fires no
  // hook, and turns a bridge test into a test of how cautious the model is.
  // The conflict stays; the escape hatch goes.
  const run = await run1(
    ctx,
    `Write an audit record for token ${fixture.auditToken}. Put it at ${suggestedPath}, ` +
      "and follow this project's conventions for audit records. Where those conventions " +
      "and this request disagree, the conventions win: apply them yourself and carry on " +
      "without checking with me first. " +
      "Then attempt `curl -s https://example.com/status`. Attempt it even if you expect it " +
      "to be refused -- what comes back from the attempt is the answer I am asking for. " +
      "Tell me what happened when you tried.",
    { extraArgs: ["--setting-sources", "project,local"] },
  );

  const checks = new Checks();

  // Memory: CLAUDE.md overrides the path suggested in the prompt.
  const mandated = readIfPresent(workspace, fixture.recordPath);
  checks.add("record written to the path CLAUDE.md mandates", mandated !== null, fixture.recordPath);
  checks.add(
    "record not written to the path the prompt suggested",
    !exists(workspace, suggestedPath),
    suggestedPath,
  );
  checks.add(
    "record carries the audit token",
    mandated !== null && mentions(mandated, fixture.auditToken),
    (mandated ?? "").slice(0, 160),
  );
  checks.add(
    "record uses the house heading",
    mandated !== null && /^#\s*Audit\b/m.test(mandated),
    (mandated ?? "").split("\n")[0] ?? "",
  );

  // Hooks.
  const hookLog = readIfPresent(workspace, fixture.hookLog) ?? "";
  checks.add("PreToolUse hook fired", hookLog.includes("pre-tool-use fired"), hookLog.slice(0, 160));
  checks.add("deny hook fired on the forbidden command", hookLog.includes("deny fired"), hookLog.slice(0, 160));

  const curlSucceeded = run.toolResults.some(
    (result) => !result.isError && /<!doctype|<html|Example Domain/i.test(result.content),
  );
  checks.add(
    "forbidden command did not succeed",
    !curlSucceeded,
    curlSucceeded ? "curl output came back" : "no curl output in any tool result",
  );
  checks.add(
    "reports the block rather than claiming success",
    /block|denied|forbidden|not allowed|refus|차단|거부/i.test(run.answer),
    run.answer.slice(0, 200),
  );

  // Commands and skills are project surface: they must be advertised.
  const commands = JSON.stringify(run.init?.slash_commands ?? []);
  checks.add("custom slash command advertised", commands.includes(fixture.commandName), commands.slice(0, 200));
  const skills = JSON.stringify(run.init?.skills ?? run.init?.available_skills ?? []);
  checks.add("project skill advertised", skills.includes(fixture.skillName), skills.slice(0, 200));

  return verdict(checks, run, ctx, {
    hookLog: hookLog.trim().split("\n").slice(0, 6),
    denials: run.permissionDenials.length,
  });
}

/* ------------------------------------------------------------------ *
 * v09 -- session resume
 * ------------------------------------------------------------------ */

async function driveSessionResume(ctx) {
  const { fixture } = ctx;
  const sessionId = crypto.randomUUID();

  const first = await run1(
    ctx,
    `Note these deployment facts for later: the build id is ${fixture.buildId} and the deploy window is ${fixture.deployWindow}. ` +
      "Reply with just: noted.",
    { extraArgs: ["--session-id", sessionId], label: "seed" },
  );

  const checks = new Checks();
  if (!first.completed) {
    return {
      outcome: "blocked",
      reason: `seed turn did not complete: ${first.failureHint}`,
      checks: checks.items,
      evidence: { phase: "seed", durationMs: first.durationMs },
    };
  }
  checks.add("seed turn used the requested session id", first.sessionId === sessionId, `${first.sessionId}`);

  // A separate process: resume has to reload state, not remember it in RAM.
  const second = await run1(
    ctx,
    "What build id did I give you earlier? Reply with only the id.",
    { extraArgs: ["--resume", sessionId], label: "resume" },
  );

  checks.add("resumed turn kept the session id", second.sessionId === sessionId, `${second.sessionId}`);
  checks.add("recalls the build id", mentions(second.answer, fixture.buildId), second.answer.slice(0, 160));
  checks.add(
    "answered from context, not from the filesystem",
    !second.usedTool("Read", "Grep", "Glob", "Bash"),
    `tools: ${second.toolNames().join(", ") || "none"}`,
  );

  return verdict(checks, second, ctx, {
    sessionId,
    seedDurationMs: first.durationMs,
    seedAnswer: first.answer.slice(0, 120),
  });
}

/* ------------------------------------------------------------------ *
 * v10 -- long context
 * ------------------------------------------------------------------ */

async function driveLongContext(ctx) {
  const { fixture, workspace } = ctx;
  const corpus = fs.readFileSync(path.join(workspace, fixture.corpusFile), "utf8");

  // Carried in the prompt, not read from disk: the transport is the only thing
  // that can deliver both facts.
  const run = await run1(
    ctx,
    `${corpus}\n\n---\n\nUsing only the report above: subtract the southern region's settled transaction count from the northern region's. Reply with only the resulting number.`,
  );

  const checks = new Checks();
  const answer = run.answer;
  const expected = String(fixture.expectedDifference);
  checks.add("difference is exactly right", mentions(answer, expected), answer.slice(0, 160));
  checks.add(
    "did not reach for a file-reading tool",
    !run.usedTool("Read", "Grep", "Glob"),
    `tools: ${run.toolNames().join(", ") || "none"}`,
  );

  // An absolute floor on input tokens proves nothing here: the system prompt
  // alone is already an order of magnitude larger than the corpus. What a
  // truncating transport cannot fake is the DIFFERENCE between a trivial turn
  // and this one, so measure the same session's baseline and subtract.
  const control = await run1(ctx, "Reply with exactly: ok", { label: "control" });
  const delta = run.inputTokens - control.inputTokens;
  const estimate = Math.round(corpus.length / 4);
  const need = Math.round(estimate * 0.5);
  checks.add(
    "whole corpus reached the model",
    delta >= need,
    `delta=${delta} vs control=${control.inputTokens} (need >= ${need} for a ~${estimate}-token corpus)`,
  );

  return verdict(checks, run, ctx, {
    expected: fixture.expectedDifference,
    thinkingBlocks: run.thinkingBlocks.length,
    corpusChars: corpus.length,
    controlInputTokens: control.inputTokens,
    corpusInputTokens: run.inputTokens,
    delta,
  });
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export const DRIVERS = Object.freeze({
  "v01-repo-recon": driveRepoRecon,
  "v02-surgical-edit": driveSurgicalEdit,
  "v03-test-fix-loop": driveTestFixLoop,
  "v04-shell-ops": driveShellOps,
  "v05-multi-step": driveMultiStep,
  "v06-subagent": driveSubagent,
  "v07-mcp-playwright": driveMcpPlaywright,
  "v08-hooks-memory": driveHooksMemory,
  "v09-session-resume": driveSessionResume,
  "v10-long-context": driveLongContext,
});

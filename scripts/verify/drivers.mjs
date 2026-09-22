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

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { runHeadless, sanitizeEnv, servedExpectedModel } from "./session.mjs";
import { exists, gitLogSubjects, readIfPresent } from "./fixtures.mjs";
import { ROOT_DIR } from "./bridge.mjs";
import { DEFAULT_TIMEOUTS } from "./timeouts.mjs";
import { runProcess } from "./process.mjs";

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

/** Judge one mandatory phase without letting its files or prose mask a bad turn. */
export function phaseVerdict(label, run, ctx) {
  const transport = run ? transportVerdict(run, ctx) : { blocked: true, reason: "phase did not run" };
  const envelope = new Checks();
  if (run) envelopeChecks(envelope, run);
  const pairing = run?.pairingReport() ?? null;
  const model = run ? servedExpectedModel(run, ctx) : { ok: false, served: [], reason: "phase did not run" };
  const checks = new Checks();
  checks.add("completed", run?.completed === true, run?.failureHint ?? (run ? "completed" : "phase did not run"));
  checks.add("tool_use/tool_result pairing", pairing?.ok === true, JSON.stringify(pairing));
  checks.add("expected model served", model.ok, model.reason ?? model.served.join(", "));
  checks.items.push(...envelope.items);
  const outcome = transport.blocked ? "blocked" : envelope.ok ? "pass" : "fail";
  const reason = transport.blocked ? transport.reason : envelope.summary();
  return {
    outcome,
    reason: reason ? `${label}: ${reason}` : "",
    checks: checks.items.map((item) => ({ ...item, name: `${label}: ${item.name}` })),
    evidence: {
      completed: run?.completed === true,
      pairing,
      model,
      envelope: { ok: Boolean(run) && envelope.ok, checks: envelope.items },
      transcriptPath: run?.transcriptPath ?? null,
      tools: run?.toolNames() ?? [],
      servedModels: model.served,
      durationMs: run?.durationMs ?? 0,
      inputTokens: run?.inputTokens ?? null,
      answer: run?.answer.slice(0, 600) ?? "",
      exitCode: run?.exitCode ?? null,
      signal: run?.signal ?? null,
      timedOut: run?.timedOut === true,
      spawnError: run?.spawnError ?? null,
    },
  };
}

// Space, comma and underscore come out of both sides, so a model that re-spaces
// a value it copied correctly is not failed over the spacing.
//
// The hyphen deliberately stays. normalise() runs over the HAYSTACK too, and
// the haystack is the model's own free text: strip "-" there and the needle
// "37" -- v01's only check separating "read the constant" from "waffled about
// the file" -- matches "lines 3-7 of config.mjs", "8123" matches "build 81-23",
// and "Thursday 02:00 UTC" matches "Thursday 02:00-UTC". Digits either side of
// a hyphen are precisely what these scenarios ask a model to cite, so the
// tolerance would hand out passes nobody earned.
const normalise = (value) => String(value ?? "").replace(/[\s,_]+/g, "").toLowerCase();

// The one place a hyphen may be forgiven: needles the harness generated itself
// and rendered into an image. Two models made the identical mis-read of the
// same rasterised prefix and only the separator they happened to type
// ("IMG TAG" vs "IMG-TAG") decided which of them passed. A media token is a
// fixed, separator-free string carrying six hex characters of entropy, so no
// answer matches one by accident the way prose or a two-digit number does.
// Use this for media tokens and nothing else; mentions() covers the rest.
const normaliseToken = (value) => String(value ?? "").replace(/[\s,_-]+/g, "").toLowerCase();

// Both are exported for the structural tests, which pin the split above rather
// than trusting two regexes a line apart to be read correctly.
export function mentions(haystack, needle) {
  return normalise(haystack).includes(normalise(needle));
}

export function mentionsToken(haystack, needle) {
  return normaliseToken(haystack).includes(normaliseToken(needle));
}

/**
 * What a tool actually answered, joined over every call of that tool.
 *
 * Tool output is machine-written, so it is compared with plain `includes`:
 * mentions()/mentionsToken() exist to forgive a model's own re-spacing of a
 * value, and nothing here passes through a model.
 */
function toolResultText(run, name) {
  const ids = new Set(run.usesOf(name).map((use) => use.id));
  return run.toolResults
    .filter((result) => ids.has(result.id))
    .map((result) => result.content)
    .join("\n");
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
 *
 * It is a default rather than a constant because a mode that is never varied
 * is a mode that was never tested: v02 runs one turn under `plan` precisely to
 * watch the edit be withheld.
 */
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

async function run1(
  ctx,
  prompt,
  {
    extraArgs = [],
    label = "main",
    permissionMode = DEFAULT_PERMISSION_MODE,
    inputFormat = "text",
    replayUserMessages = false,
    timeoutSeconds = ctx.timeoutSeconds,
  } = {},
) {
  const transcriptPath = path.join(ctx.slotDir, `transcript-${label}.jsonl`);
  const run = await runHeadless({
    prompt,
    cwd: ctx.workspace,
    settingsPath: ctx.settingsPath,
    frontendModel: ctx.frontendModel,
    configDir: ctx.configDir,
    claudeBin: ctx.claudeBin,
    timeoutSeconds,
    transcriptPath,
    extraArgs: ["--permission-mode", permissionMode, ...extraArgs],
    inputFormat,
    replayUserMessages,
  });
  run.transcriptPath = transcriptPath;
  return run;
}

function verdict(checks, run, ctx, evidence = {}, phases = { main: run }) {
  const judged = Object.entries(phases).map(([label, phase]) => [label, phaseVerdict(label, phase, ctx)]);
  for (const [, phase] of judged) checks.items.push(...phase.checks);
  const blocked = judged.some(([, phase]) => phase.outcome === "blocked");
  return {
    outcome: blocked ? "blocked" : checks.ok ? "pass" : "fail",
    reason: blocked
      ? judged.filter(([, phase]) => phase.outcome !== "pass").map(([, phase]) => phase.reason).join("; ")
      : checks.ok ? "" : checks.summary(),
    checks: checks.items,
    evidence: {
      ...evidence,
      tools: run.toolNames(),
      servedModels: servedExpectedModel(run, ctx).served,
      durationMs: run.durationMs,
      inputTokens: run.inputTokens,
      answer: run.answer.slice(0, 600),
      phases: Object.fromEntries(judged.map(([label, phase]) => [label, {
        outcome: phase.outcome, reason: phase.reason, ...phase.evidence,
      }])),
    },
  };
}

/* ------------------------------------------------------------------ *
 * v01 -- repository reconnaissance
 * ------------------------------------------------------------------ */

async function driveRepoRecon(ctx) {
  const { fixture } = ctx;
  // Driven through the stream-json INPUT path, not plain text. The output half
  // rides every other scenario; the input half is a separate parser and had no
  // coverage at all. --replay-user-messages is what makes it observable: the
  // CLI only echoes a user message back if it parsed the envelope.
  const run = await run1(
    ctx,
    "This repository applies a spread when settlements cross a clearing window. " +
      "Find the file that DEFINES the constant holding that spread. " +
      "Reply with exactly two lines: the relative path on the first line, and the constant's numeric value on the second. No other text.",
    { inputFormat: "stream-json", replayUserMessages: true },
  );

  const checks = new Checks();
  const answer = run.answer;

  const replays = run.replayedUserMessages;
  checks.add(
    "the stream-json input envelope was parsed and replayed",
    replays.length > 0,
    `replayed user messages: ${replays.length}`,
  );
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

  // Plan mode runs first, aimed at a DIFFERENT line than the edit turn will
  // touch. Withholding is judged on the file, not on the model saying it held
  // back, and because the plan target is already in `untouched` below, a plan
  // turn that wrote gets caught twice.
  //
  // Completion is checked as well as the bytes: a build that blocks waiting for
  // plan approval leaves the file just as unchanged as one that correctly
  // withheld, and headless that hang is its own failure.
  //
  // The turn is kept deliberately narrow. Left open, a model read "plan" as
  // licence to delegate: it spawned a subagent, which opened a nested session
  // and a background task, and the turn spent the scenario's entire budget in
  // API retries before timing out. None of that was about plan mode. The
  // capability under test is one file and one line, so the prompt says so, and
  // its own short budget keeps a turn that does hang from starving the edit
  // turn that follows.
  const plan = await run1(
    ctx,
    `In ${fixture.targetFile}, change ${fixture.planTargetKey} to ${fixture.planNewValue}. ` +
      "Do this yourself — do not delegate it to a subagent or a background task.",
    {
      permissionMode: "plan",
      label: "plan",
      timeoutSeconds: (ctx.timeouts ?? DEFAULT_TIMEOUTS).planTurnMs / 1000,
    },
  );
  const afterPlan = readIfPresent(workspace, fixture.targetFile) ?? "";

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
    "plan-mode turn finished instead of hanging for approval",
    plan.completed,
    plan.failureHint ?? `stop_reason=${plan.result?.stop_reason ?? "none"}`,
  );
  checks.add(
    "plan-mode withheld the edit",
    !new RegExp(`${fixture.planTargetKey}\\s*:\\s*${fixture.planNewValue}\\b`).test(afterPlan),
    afterPlan.slice(0, 240),
  );

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

  return verdict(checks, run, ctx, {
    planStopReason: plan.result?.stop_reason ?? null,
    planTools: plan.toolNames(),
    planDurationMs: plan.durationMs,
  }, { plan, edit: run });
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

/** Porcelain -z separates fields and records with NULs, not path whitespace. */
export function parseWorktreeList(output) {
  if (!output.endsWith("\0\0")) return null;
  const records = [];
  for (const record of output.slice(0, -2).split("\0\0")) {
    const fields = Object.create(null);
    for (const field of record.split("\0")) {
      const space = field.indexOf(" ");
      const key = space < 0 ? field : field.slice(0, space);
      if (Object.hasOwn(fields, key)) return null;
      fields[key] = space < 0 ? "" : field.slice(space + 1);
    }
    const detached = Object.hasOwn(fields, "detached");
    if (!record.startsWith("worktree ") || !path.isAbsolute(fields.worktree ?? "") ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields.HEAD ?? "") ||
      (detached ? fields.branch !== undefined : !/^refs\/heads\/.+/.test(fields.branch ?? ""))) return null;
    records.push({ path: fields.worktree, head: fields.HEAD, branch: fields.branch ?? null,
      detached, prunable: Object.hasOwn(fields, "prunable") });
  }
  return records;
}

function realpathOrNull(dir) {
  try { return fs.realpathSync(dir); } catch { return null; }
}

async function driveShellOps(ctx) {
  const { fixture, workspace } = ctx;
  const nativeBranch = `worktree-${fixture.worktreeBranch.replaceAll("/", "+")}`;
  const run = await run1(
    ctx,
    `Start \`node ${fixture.tickerScript} ${fixture.logFile}\` as a background process. ` +
      `Poll its output until ${fixture.logFile} holds at least ${fixture.minTicks} ticks, then stop that process. ` +
      `Write ${fixture.recordFile} containing the number of ticks recorded. ` +
      `Then create a second git worktree: either use Bash to add ${fixture.worktreeDir} on a new branch named ${fixture.worktreeBranch}, ` +
      `or use EnterWorktree with name "${fixture.worktreeBranch}" (its branch ${nativeBranch} and tool-selected directory are equally acceptable). ` +
      `Inside that worktree create ${fixture.worktreeFile} containing ${fixture.worktreeMarker} and commit it there. ` +
      `Keep the worktree and branch for verification, then return to the original checkout (ExitWorktree with action "keep" if needed). ` +
      `The review file must not appear in this checkout or its commits. ` +
      `Finally, back here, commit the tick log and record file with exactly this message: ${fixture.commitSubject}`,
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

  // Native EnterWorktree and plain git use different names. Match exact refs
  // from Git's registry, never a substring in a path or a model's success claim.
  const git = (cwd, args) => runProcess("git", args, { cwd, timeoutMs: 10_000 });
  const listing = await git(workspace, ["worktree", "list", "--porcelain", "-z"]);
  const registered = listing.completed ? parseWorktreeList(listing.stdout) : null;
  checks.add(
    "git worktree registry is readable",
    registered !== null,
    JSON.stringify({ status: listing.status, signal: listing.signal, error: listing.error?.message,
      stderr: listing.stderr.slice(0, 300), records: registered?.length ?? null }),
  );
  const expectedBranches = [fixture.worktreeBranch, nativeBranch].map((branch) => `refs/heads/${branch}`);
  const primaryPath = realpathOrNull(workspace);
  const worktrees = (registered ?? []).map((entry) => ({ ...entry, realPath: realpathOrNull(entry.path) }));
  const primary = worktrees.filter((entry) => entry.realPath && entry.realPath === primaryPath);
  const candidates = worktrees.filter((entry) => entry.realPath && entry.realPath !== primaryPath &&
    !entry.detached && !entry.prunable && expectedBranches.includes(entry.branch));
  const worktree = primary.length === 1 && candidates.length === 1 &&
    candidates[0].branch !== primary[0].branch ? candidates[0] : null;
  checks.add(
    "a second worktree is registered on its own branch",
    worktree !== null,
    JSON.stringify({ expectedBranches, candidates: candidates.length, registered: worktrees.slice(0, 10) }),
  );

  // All evidence must describe this one checkout, including the committed blob.
  const hasMarker = (text) => (text ?? "").split(/[^A-Za-z0-9_-]+/).includes(fixture.worktreeMarker);
  const markerInWorktree = worktree ? readIfPresent(worktree.realPath, fixture.worktreeFile) : null;
  checks.add(
    "the marker file exists inside the worktree",
    hasMarker(markerInWorktree),
    markerInWorktree === null
      ? `${fixture.worktreeFile} missing at ${worktree?.path ?? "no unique worktree"}`
      : markerInWorktree.slice(0, 120),
  );
  const committed = worktree ? await git(worktree.realPath, ["show", `HEAD:${fixture.worktreeFile}`]) : null;
  checks.add(
    "the worktree marker is committed unchanged",
    committed?.completed === true && hasMarker(committed.stdout) && committed.stdout === markerInWorktree,
    committed ? JSON.stringify({ path: worktree.path, branch: worktree.branch, head: worktree.head,
      status: committed.status, error: committed.error?.message, stderr: committed.stderr.slice(0, 300) })
      : "no unique worktree to inspect",
  );
  // An unsuccessful `git show` would not prove absence: require a successful,
  // empty tree listing as well as absence on disk in the primary checkout.
  const primaryMarker = await git(workspace, ["ls-tree", "-z", "HEAD", "--", fixture.worktreeFile]);
  const absentFromPrimary = !exists(workspace, fixture.worktreeFile) &&
    primaryMarker.completed && primaryMarker.stdout === "";
  checks.add(
    "the marker file is absent from the primary checkout",
    absentFromPrimary,
    absentFromPrimary ? `${fixture.worktreeFile} absent from disk and HEAD` :
      JSON.stringify({ file: fixture.worktreeFile, onDisk: exists(workspace, fixture.worktreeFile),
        status: primaryMarker.status, error: primaryMarker.error?.message, treeEntry: primaryMarker.stdout,
        stderr: primaryMarker.stderr.slice(0, 300) }),
  );

  return verdict(checks, run, ctx, {
    ticks: ticks.length,
    subjects: subjects.slice(0, 3),
    worktrees: worktrees.slice(0, 10),
    expectedWorktreeBranches: expectedBranches,
    selectedWorktree: worktree,
  });
}

/* ------------------------------------------------------------------ *
 * v05 -- tracked multi-step execution
 * ------------------------------------------------------------------ */

async function driveMultiStep(ctx) {
  const { fixture, workspace } = ctx;
  // The two reads are asked for in their own sentence rather than as steps 5
  // and 6. The check below compares what the answer claims against what landed
  // on disk, and only the four edits leave anything on disk -- numbering the
  // reads alongside them would have the model claim six against a count of
  // four. They still get a sentence of their own: as a trailing clause on the
  // fourth edit they were easy to summarise away.
  const run = await run1(
    ctx,
    "Four changes, please. Complete all four:\n" +
      '1. In src/greet.mjs, change the greeting text from "Hello" to "Good morning".\n' +
      "2. Bump the VERSION file to 0.2.0.\n" +
      `3. Create CHANGELOG.md whose first entry mentions the release token ${fixture.token}.\n` +
      `4. In ${fixture.notebookFile}, change RATE from 0.05 to ${fixture.newRate}.\n` +
      `Then open ${fixture.pdfFile} and ${fixture.pngFile} and read the token printed in each.\n` +
      "Each token is exactly 12 characters: a six-letter uppercase prefix followed by six uppercase hexadecimal characters (0-9, A-F).\n" +
      "Keep repeated characters and verify the 12-character length before reporting.\n" +
      "Report which of the four changes you completed, then the PDF's token and the image's " +
      "token, each on its own line and copied exactly as it is written.",
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

  const landed = fixture.steps.filter((step) => {
    const content = readIfPresent(workspace, step.file);
    return content !== null && mentions(content, step.expect);
  }).length;

  // A claim of completion with nothing on disk is the failure this catches.
  //
  // The wording is the model's, not the prompt's, so one phrase is not enough:
  // keyed to "all four" alone, an answer that says "all of the changes" is
  // never compared against the disk and the check passes for a model that
  // landed nothing. Sentences carrying a negation are dropped first, so an
  // honest "I could not complete all four" is not read as the claim it denies.
  const claimsEveryStep = run.answer
    .split(/(?<=[.!?\n])/)
    .filter((sentence) => !/\b(?:not|cannot|unable|except|failed|skipped)\b|n't/i.test(sentence))
    .some((sentence) =>
      /\bcompleted all\b|\beverything\b|\b(?:all|every) (?:of )?(?:the )?(?:four|4|them|changes|steps|edits)\b/i.test(
        sentence,
      ),
    );
  checks.add(
    "no step was claimed without the file backing it",
    !claimsEveryStep || landed === fixture.steps.length,
    `landed ${landed}/${fixture.steps.length}`,
  );

  // The two binary attachments. Neither token is derived from anything the
  // prompt says, so the only way to report one is to have received the bytes:
  // a PDF page and an image, both of which arrive as non-text content blocks
  // inside a tool_result. That block is what a text-only translation layer
  // drops, and dropping it is invisible from the prose alone.
  checks.add(
    "the PDF's token came back",
    mentionsToken(run.answer, fixture.pdfToken),
    `looked for ${fixture.pdfToken} in: ${run.answer.slice(0, 200)}`,
  );
  checks.add(
    "the image's token came back",
    mentionsToken(run.answer, fixture.pngToken),
    `looked for ${fixture.pngToken} in: ${run.answer.slice(0, 200)}`,
  );

  return verdict(checks, run, ctx, {
    landed,
    steps: fixture.steps.length,
    attachmentErrors: run.toolResults.filter((r) => r.isError).map((r) => r.content.slice(0, 120)),
  });
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
    { extraArgs: ["--setting-sources", "project,local", "--plugin-dir", fixture.pluginDir] },
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

  // The same two surfaces again, but supplied by --plugin-dir rather than by
  // .claude/. They ride different keys through the init event, so a bridge can
  // carry project files faithfully and still lose every plugin.
  checks.add(
    "plugin-supplied slash command advertised",
    commands.includes(fixture.pluginCommandName),
    commands.slice(0, 240),
  );
  checks.add(
    "plugin-supplied skill advertised",
    skills.includes(fixture.pluginSkillName),
    skills.slice(0, 240),
  );

  // Cron gets its own turn. The main turn is already carrying a conventions
  // conflict and a denied command; a third task in the same breath is how
  // steps start getting dropped, and a dropped step here would read as a
  // missing capability.
  //
  // The job cannot be watched firing -- the scheduler only runs while the REPL
  // is idle, and this is one headless turn. What is judgeable is that the tool
  // exists, took the schedule, and the job comes back out of the list.
  const cron = await run1(
    ctx,
    `Use the CronCreate tool to schedule a one-shot task with the cron expression \`${fixture.cronExpression}\` ` +
      `and the prompt \`${fixture.cronPrompt}\`. Then call CronList and reply with exactly the job id you got back.`,
    { label: "cron" },
  );
  // "CronList was called" is not "the job came back out of the list". An empty
  // list answers the call, and the previous formula -- usedTool(create) &&
  // usedTool(list) -- passed on one: replaying the seven recorded v08 cron
  // transcripts with the CronList result blanked to "No scheduled tasks." left
  // it true for all seven.
  //
  // So read what CronList actually returned and look in it for the job, by two
  // independent anchors, either of which settles it and neither of which an
  // empty list can produce:
  //   - the identifier CronCreate echoed back, and
  //   - this slot's own cron prompt, which the list renders and which exists
  //     in no other job on the machine.
  // The id alone would go red if Claude Code stopped printing one in the
  // create line; the prompt alone would go red if a model paraphrased what it
  // scheduled. The digit filter keeps an ordinary a-f word ("decade") from
  // standing in for an id.
  const cronCreated = toolResultText(cron, "CronCreate");
  const cronListed = toolResultText(cron, "CronList");
  const echoedId =
    [...cronCreated.matchAll(/\b[0-9a-f]{6,}\b/gi)]
      .map((match) => match[0])
      .filter((candidate) => /\d/.test(candidate))
      .find((candidate) => cronListed.includes(candidate)) ?? null;
  checks.add(
    "cron job was created and came back out of the list",
    cron.usedTool("CronCreate") &&
      cron.usedTool("CronList") &&
      (Boolean(echoedId) || cronListed.includes(fixture.cronPrompt)),
    `tools: ${cron.toolNames().join(", ") || "none"} — list: ${cronListed.slice(0, 160) || "(no result)"}`,
  );

  return verdict(checks, run, ctx, {
    hookLog: hookLog.trim().split("\n").slice(0, 6),
    denials: run.permissionDenials.length,
    cronTools: cron.toolNames(),
    cronAnswer: cron.answer.slice(0, 120),
    cronListed: cronListed.slice(0, 160),
    cronListedId: echoedId,
  }, { main: run, cron });
}

/* ------------------------------------------------------------------ *
 * v09 -- session resume
 * ------------------------------------------------------------------ */

async function driveSessionResume(ctx) {
  const { fixture } = ctx;
  const sessionId = crypto.randomUUID();

  const first = await run1(
    ctx,
    `The example deployment has build id ${fixture.buildId} and deploy window ${fixture.deployWindow}. Keep these literal values in this conversation only. ` +
      "Do not use tools, write files, or save persistent memory. Do not add or infer a calendar date. Reply with just: noted.",
    { extraArgs: ["--session-id", sessionId], label: "seed" },
  );

  const checks = new Checks();
  // Seed memory writes can be auto-loaded later, bypassing transcript inheritance.
  checks.add(
    "seed used no tools",
    first.toolUses.length === 0,
    `tools: ${first.toolNames().join(", ") || "none"}`,
  );
  if (phaseVerdict("seed", first, ctx).outcome !== "pass") {
    return verdict(checks, first, ctx, { phase: "seed", sessionId }, { seed: first, resume: null, fork: null });
  }
  checks.add("seed turn used the requested session id", first.sessionId === sessionId, `${first.sessionId}`);

  // A separate process: resume has to reload state, not remember it in RAM.
  const second = await run1(
    ctx,
    "What is the example deployment's build id? Reply with only the original value from our conversation. " +
      "Do not use tools, files, or persistent memory.",
    { extraArgs: ["--resume", sessionId], label: "resume" },
  );

  checks.add("resumed turn kept the session id", second.sessionId === sessionId, `${second.sessionId}`);
  checks.add("recalls the build id", mentions(second.answer, fixture.buildId), second.answer.slice(0, 160));
  checks.add(
    "resume used no tools",
    second.toolUses.length === 0,
    `tools: ${second.toolNames().join(", ") || "none"}`,
  );
  checks.add(
    "answered from context, not from the filesystem",
    !second.usedTool("Read", "Grep", "Glob", "Bash"),
    `tools: ${second.toolNames().join(", ") || "none"}`,
  );

  // A fork is resume's other half: inherit the transcript, then branch off it.
  // Both halves have to hold at once, and they pull in opposite directions --
  // the fork must know the SECOND fact from the seed turn while carrying a
  // session id of its own. A bridge that keys state on the id alone gives a
  // fork that remembers nothing; one that ignores --fork-session gives a fork
  // that remembers everything under the original id and silently writes into
  // the conversation it was supposed to branch away from.
  const forked = await run1(
    ctx,
    "What is the example deployment's deploy window? Reply with only the original weekday, time, and timezone from our conversation, " +
      "without adding a calendar date. Do not use tools, files, or persistent memory.",
    { extraArgs: ["--resume", sessionId, "--fork-session"], label: "fork" },
  );

  checks.add(
    "fork used no tools",
    forked.toolUses.length === 0,
    `tools: ${forked.toolNames().join(", ") || "none"}`,
  );
  checks.add(
    "fork inherited the seed turn's context",
    mentions(forked.answer, fixture.deployWindow),
    forked.answer.slice(0, 160),
  );
  checks.add(
    "fork runs under a session id of its own",
    Boolean(forked.sessionId) && forked.sessionId !== sessionId,
    `fork=${forked.sessionId} original=${sessionId}`,
  );

  return verdict(checks, second, ctx, {
    sessionId,
    forkSessionId: forked.sessionId,
    seedDurationMs: first.durationMs,
    seedAnswer: first.answer.slice(0, 120),
    forkAnswer: forked.answer.slice(0, 120),
  }, { seed: first, resume: second, fork: forked });
}

/* ------------------------------------------------------------------ *
 * v10 -- long context
 * ------------------------------------------------------------------ */

async function driveLongContext(ctx) {
  const { fixture, workspace } = ctx;
  const corpus = fs.readFileSync(path.join(workspace, fixture.corpusFile), "utf8");

  // Carried in the prompt, not read from disk: the transport is the only thing
  // that can deliver both facts.
  //
  // The answer is taken through --json-schema rather than as prose. Structured
  // output is a wire-format change on the result envelope -- exactly where a
  // translating bridge is most likely to drop a field -- and it buys this
  // scenario a stricter verdict at the same time: a typed number compared for
  // equality, instead of hunting for a digit string inside free text that may
  // also contain the two operands.
  const run = await run1(
    ctx,
    `${corpus}\n\n---\n\nUsing only the report above: subtract the southern region's settled transaction count from the northern region's. Reply with only the resulting number.`,
    {
      extraArgs: [
        "--json-schema",
        JSON.stringify({
          type: "object",
          properties: { difference: { type: "number" } },
          required: ["difference"],
          additionalProperties: false,
        }),
      ],
    },
  );

  const checks = new Checks();
  const answer = run.answer;
  const expected = String(fixture.expectedDifference);
  const structured = run.structuredOutput;
  checks.add(
    "result carried a schema-valid structured object",
    structured !== null && typeof structured.difference === "number",
    structured === null ? `no structured output; raw: ${answer.slice(0, 120)}` : JSON.stringify(structured).slice(0, 160),
  );
  checks.add(
    "difference is exactly right",
    structured?.difference === fixture.expectedDifference,
    `got ${JSON.stringify(structured?.difference)} want ${expected}`,
  );
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
  // Missing/failed usage is not a zero-token baseline. Neither side of this
  // comparison is meaningful until both mandatory turns pass their wire checks.
  const comparable = phaseVerdict("corpus", run, ctx).outcome === "pass" &&
    phaseVerdict("control", control, ctx).outcome === "pass";
  const delta = comparable ? run.inputTokens - control.inputTokens : null;
  const estimate = Math.round(corpus.length / 4);
  const need = Math.round(estimate * 0.5);
  checks.add(
    "whole corpus reached the model",
    delta !== null && delta >= need,
    delta === null ? "not evaluated: corpus or control phase failed" :
      `delta=${delta} vs control=${control.inputTokens} (need >= ${need} for a ~${estimate}-token corpus)`,
  );

  return verdict(checks, run, ctx, {
    expected: fixture.expectedDifference,
    thinkingBlocks: run.thinkingBlocks.length,
    corpusChars: corpus.length,
    controlInputTokens: control.inputTokens,
    corpusInputTokens: run.inputTokens,
    delta,
  }, { corpus: run, control });
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * v11 -- launcher, daemon and background agent
 * ------------------------------------------------------------------ */

/**
 * The only driver that does not go through runHeadless.
 *
 * Every other scenario is handed a bridge the harness started and a settings
 * file the harness wrote, which is the right shape for testing Claude Code
 * over this transport but skips the two pieces this project actually ships:
 * `bin/claude-ghcp`, and the daemon it leaves behind. So this one shells out
 * to the launcher exactly as a user would.
 *
 * GHCP_DAEMON_DIR is slot-local, which is what makes every primary model safe to run
 * at once: the registry, log and lock the daemon arbitrates on are per-slot
 * files, so concurrent slots cannot adopt or stop one another's daemon.
 *
 * ctx.bridge is running too and goes unused here. That is deliberate -- the
 * runner starts one per slot unconditionally, and the daemon picking its own
 * free port is itself part of what this checks.
 */
async function driveDaemonBackground(ctx) {
  const { fixture, workspace, configDir, slotDir } = ctx;
  const timeouts = ctx.timeouts ?? DEFAULT_TIMEOUTS;

  const daemonDir = path.join(slotDir, "daemon");
  fs.mkdirSync(daemonDir, { recursive: true });

  const bin = (name) => path.join(ROOT_DIR, "bin", name);
  const env = {
    ...sanitizeEnv(),
    GHCP_DAEMON_DIR: daemonDir,
    CLAUDE_CONFIG_DIR: configDir,
  };
  const checks = new Checks();
  const evidence = { commands: {} };
  const sh = async (file, args, timeoutSeconds, label) => {
    const out = await runProcess(file, args, {
      cwd: workspace,
      env,
      timeoutMs: Math.round(timeoutSeconds * 1000),
    });
    // Cleanup calls have no label; every command used as evidence must complete.
    if (label) {
      const { stdout, stderr, error, ...completion } = out;
      const prefix = `command-${label.replaceAll(" ", "-")}`;
      const stdoutFile = `${prefix}.stdout.log`;
      const stderrFile = `${prefix}.stderr.log`;
      fs.writeFileSync(path.join(slotDir, stdoutFile), stdout ?? "", { mode: 0o600 });
      fs.writeFileSync(path.join(slotDir, stderrFile), stderr ?? "", { mode: 0o600 });
      evidence.commands[label] = { ...completion, error: error?.message ?? null, stdoutFile, stderrFile };
      checks.add(`${label}: command completed`, out.completed === true,
        `exit=${out.status} signal=${out.signal} ${error?.message ?? ""}`);
    }
    return out;
  };

  const status = async (label) => {
    const out = await sh(bin("claude-ghcp-status"), [], 30, label);
    let value;
    try { value = JSON.parse(String(out.stdout ?? "").trim()); } catch {}
    checks.add(`${label}: status has a running flag`, typeof value?.running === "boolean",
      String(out.stdout ?? out.stderr ?? "").slice(0, 200));
    return value ?? {};
  };

  let backgroundId = null;
  const preserveDaemonDiagnostics = () => {
    if (evidence.daemonDiagnostics) return;
    const diagnostics = { capturedAt: new Date().toISOString(), logs: {}, backgroundState: null, errors: [] };
    evidence.daemonDiagnostics = diagnostics;
    for (const [source, name] of [
      [path.join(daemonDir, "bridge.log"), "daemon-bridge.log"],
      [path.join(configDir, "daemon.log"), "claude-daemon.log"],
    ]) {
      try {
        fs.copyFileSync(source, path.join(slotDir, name));
        fs.chmodSync(path.join(slotDir, name), 0o600);
        diagnostics.logs[name] = name;
      } catch (error) {
        diagnostics.logs[name] = null;
        if (error.code !== "ENOENT") diagnostics.errors.push(`${name}: ${error.message}`);
      }
    }
    if (backgroundId) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(configDir, "jobs", backgroundId, "state.json"), "utf8"));
        // Native job records also contain provider credentials and socket keys.
        diagnostics.backgroundState = Object.fromEntries(
          ["state", "detail", "createdAt", "updatedAt", "firstTerminalAt"]
            .filter((key) => ["string", "number"].includes(typeof state[key]))
            .map((key) => [key, typeof state[key] === "string" ? state[key].slice(0, 200) : state[key]]),
        );
      } catch (error) {
        if (error.code !== "ENOENT") diagnostics.errors.push(`background state: ${error.code ?? error.name}`);
      }
    }
    checks.add("daemon diagnostics preserved", diagnostics.errors.length === 0, diagnostics.errors.join("; "));
  };

  try {
    // --- 1. launch, detached -----------------------------------------
    //
    // `--bg` refuses bypassPermissions without an interactive disclaimer that
    // a headless slot can never give, so this is the one scenario that runs
    // under acceptEdits. Writes are still unattended; only the blanket
    // override is unavailable.
    const launch = await sh(
      bin("claude-ghcp"),
      [
        "--ghcp-model", ctx.model,
        "--background",
        "--allowedTools", "Read,Write",
        "--permission-mode", "acceptEdits",
        `Read ${fixture.channelFile} and find the value of DEPLOY_CHANNEL. ` +
          `Then use the Write tool to create ${fixture.backgroundResult} in the current directory ` +
          "containing exactly that value and nothing else.",
      ],
      timeouts.backgroundLaunchMs / 1000,
      "background launch",
    );
    const launchOut = `${launch.stdout ?? ""}${launch.stderr ?? ""}`;
    evidence.launchOutput = launchOut.slice(0, 400);

    checks.add("launcher exited cleanly", launch.status === 0, `exit=${launch.status} ${launchOut.slice(0, 200)}`);
    const idMatch = /backgrounded\s+·\s+([0-9a-f]{6,})/i.exec(launchOut);
    backgroundId = idMatch?.[1] ?? null;
    checks.add("launcher reported a backgrounded session id", Boolean(backgroundId), launchOut.slice(0, 200));

    // --- 2. the daemon is up and is the one we asked for --------------
    const first = await status("initial status");
    evidence.daemon = first;
    checks.add("daemon reports running", first.running === true, JSON.stringify(first).slice(0, 200));
    checks.add("daemon reports a live pid", Number.isInteger(first.pid) && first.pid > 0, `pid=${first.pid}`);
    checks.add("daemon reports a port", Number.isInteger(first.port) && first.port > 0, `port=${first.port}`);
    // The registry records the GHCP model the daemon was started for, not the
    // Anthropic-style frontend alias Claude Code sends (claude-haiku-4.5 vs
    // claude-haiku-4-5). Comparing against ctx.model is what makes this a real
    // check: it catches a slot that adopted a daemon left running for another
    // model, which is exactly what a shared registry would do.
    checks.add(
      "daemon serves the model this slot asked for",
      first.model === ctx.model,
      `daemon=${first.model} expected=${ctx.model}`,
    );

    // --- 3. the detached agent did real work --------------------------
    //
    // Nothing of the background session's stream reaches this process, so the
    // only admissible evidence is the file. The channel value appears in no
    // prompt -- the agent had to read the fixture to produce it.
    const deadline = Date.now() + timeouts.detachedOutputMs;
    let produced = null;
    while (Date.now() < deadline) {
      produced = readIfPresent(workspace, fixture.backgroundResult);
      if (produced !== null && produced.trim()) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    checks.add(
      "detached agent wrote the value only the fixture file holds",
      Boolean(produced && produced.includes(fixture.channelValue)),
      produced === null ? "file never appeared" : produced.slice(0, 120),
    );

    // --- 4. Claude Code's own roster sees the session -----------------
    const agents = await sh(ctx.claudeBin, ["agents", "--json", "--all"], 60, "agent roster");
    let roster = [];
    try {
      roster = JSON.parse(String(agents.stdout ?? "[]"));
    } catch {
      roster = [];
    }
    const mine = roster.filter(
      (entry) => entry?.kind === "background" && fs.realpathSync(entry.cwd ?? "/") === fs.realpathSync(workspace),
    );
    evidence.agents = roster.map((e) => ({ id: e.id, kind: e.kind, status: e.status }));
    checks.add(
      "claude agents lists a background session in this workspace",
      mine.length > 0,
      `roster=${roster.length} matching=${mine.length}`,
    );

    // --- 5. a foreground launch coexists with the daemon --------------
    //
    // `-p` with no --background leaves PERSISTENT_BRIDGE=0 in bin/claude-ghcp
    // (verified by running the launcher's own argument parser over this exact
    // argv), so this launch takes the ephemeral branch: its own bridge, its own
    // free port, and not one read of the daemon registry. It therefore proves
    // nothing about reuse -- step 6 does that -- and what it does prove is that
    // the two modes coexist: a foreground launch answers with a daemon already
    // running, and leaves it alone.
    const second = await sh(
      bin("claude-ghcp"),
      [
        "--ghcp-model", ctx.model,
        "-p",
        "--allowedTools", "Read",
        "--permission-mode", "acceptEdits",
        `Read ${fixture.buildFile} and reply with only the numeric value of BUILD_NUMBER.`,
      ],
      timeouts.foregroundLaunchMs / 1000,
      "foreground launch",
    );
    const secondOut = `${second.stdout ?? ""}`;
    evidence.foregroundAnswer = secondOut.slice(0, 200);
    checks.add("second launch answered", second.status === 0, `exit=${second.status}`);
    checks.add(
      "second launch read the file it was pointed at",
      mentions(secondOut, fixture.buildNumber),
      secondOut.slice(0, 160),
    );

    const undisturbed = await status("foreground status");
    checks.add(
      "foreground launch left the daemon undisturbed",
      undisturbed.running === true && undisturbed.pid === first.pid && undisturbed.port === first.port,
      `first=${first.pid}:${first.port} after=${undisturbed.pid}:${undisturbed.port}`,
    );

    // --- 6. a launch that does ask for the persistent bridge reuses it -
    //
    // This is the whole claim of a persistent bridge, and it needs a launch
    // that actually consults the registry. `agents` is the launcher's other
    // persistent-bridge trigger, so this one goes through ensureDaemon: it
    // reads the registry, health-probes the daemon named there, and either
    // adopts it or replaces it with a fresh one. Equal pid and port across that
    // is reuse; a silent restart moves both.
    //
    // It is a subcommand, not a turn, so the slot pays a preflight rather than
    // a second inference.
    //
    // Equal pid and port is only evidence if the launch could have changed
    // them, which is exactly what the old check got wrong. ensureDaemon hands
    // every launch a settings file of its own out of the daemon-owned 0700
    // directory, and nothing else writes there, so one more file after this
    // launch is proof it went down the daemon path at all.
    const settingsDir = path.join(daemonDir, "settings");
    const countSettings = () => {
      try {
        return fs.readdirSync(settingsDir).length;
      } catch {
        return 0;
      }
    };
    const settingsBefore = countSettings();

    const reuseLaunch = await sh(
      bin("claude-ghcp"),
      ["--ghcp-model", ctx.model, "agents", "--json", "--all"],
      timeouts.persistentLaunchMs / 1000,
      "persistent launch",
    );
    const reuseOut = `${reuseLaunch.stdout ?? ""}${reuseLaunch.stderr ?? ""}`;
    evidence.reuseLaunch = reuseOut.slice(0, 200);
    checks.add(
      "persistent-bridge launch exited cleanly",
      reuseLaunch.status === 0,
      `exit=${reuseLaunch.status} ${reuseOut.slice(0, 160)}`,
    );

    const settingsAfter = countSettings();
    evidence.daemonSettings = { before: settingsBefore, after: settingsAfter };
    checks.add(
      "persistent-bridge launch went through the daemon",
      settingsAfter > settingsBefore,
      `settings files ${settingsBefore} -> ${settingsAfter}`,
    );

    const reused = await status("persistent status");
    checks.add(
      "persistent-bridge launch reused the running daemon",
      reused.running === true && reused.pid === first.pid && reused.port === first.port,
      `first=${first.pid}:${first.port} after=${reused.pid}:${reused.port}`,
    );

    // --- 7. stop actually stops, and leaves nothing behind ------------
    preserveDaemonDiagnostics();
    const stopped = await sh(bin("claude-ghcp-stop"), [], 60, "daemon stop");
    let stopReport = {};
    try {
      stopReport = JSON.parse(String(stopped.stdout ?? "{}").trim());
    } catch {
      stopReport = {};
    }
    checks.add("stop reports stopped", stopReport.stopped === true, JSON.stringify(stopReport).slice(0, 160));

    const after = await status("stopped status");
    checks.add("daemon is no longer running", after.running === false, JSON.stringify(after).slice(0, 160));
    checks.add(
      "registry and log are cleaned up",
      !fs.existsSync(path.join(daemonDir, "bridge.json")) && !fs.existsSync(path.join(daemonDir, "bridge.log")),
      fs.readdirSync(daemonDir).join(", ") || "empty",
    );
  } finally {
    // The daemon and the detached agent both outlive this function by design,
    // so a slot that throws anywhere above would leak a process and a bound
    // port for the rest of the run.
    preserveDaemonDiagnostics();
    if (backgroundId) {
      try { await sh(ctx.claudeBin, ["stop", backgroundId], 30); } catch {}
    }
    try { await sh(bin("claude-ghcp-stop"), [], 30); } catch {}
  }

  return {
    outcome: checks.ok ? "pass" : "fail",
    reason: checks.ok ? "" : checks.summary(),
    checks: checks.items,
    evidence,
  };
}

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
  "v11-daemon-background": driveDaemonBackground,
});

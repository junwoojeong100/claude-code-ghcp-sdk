/** Offline driver regressions: fake CLI transcripts, never a live model. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { DRIVERS, parseWorktreeList, phaseVerdict } from "../scripts/verify/drivers.mjs";
import { buildFixture, commitAll } from "../scripts/verify/fixtures.mjs";
import { HeadlessRun, servedExpectedModel } from "../scripts/verify/session.mjs";

const MODEL = "verification-test-model";
const SCENARIOS = {
  edit: "v02-surgical-edit",
  media: "v05-multi-step",
  cron: "v08-hooks-memory",
  resume: "v09-session-resume",
  corpus: "v10-long-context",
};

function fakeContext(t, scenario, badPhase, defect = {}) {
  const slotDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-driver-test-"));
  t.after(() => fs.rmSync(slotDir, { recursive: true, force: true }));
  const workspace = path.join(slotDir, "workspace");
  const configDir = path.join(slotDir, "config");
  fs.mkdirSync(workspace);
  fs.mkdirSync(configDir);
  const settingsPath = path.join(slotDir, "settings.json");
  fs.writeFileSync(settingsPath, "{}");
  let fixture;
  let phases;
  let defaultPhase;
  if (scenario === SCENARIOS.edit) {
    fixture = {
      targetFile: "config.mjs", targetKey: "retryMs", newValue: 80,
      planTargetKey: "keepMs", planNewValue: 20,
      newFile: "budget.mjs", newExport: "budget", untouched: ["  keepMs: 10,"],
    };
    fs.writeFileSync(path.join(workspace, fixture.targetFile), "export default {\n  retryMs: 40,\n  keepMs: 10,\n};\n");
    defaultPhase = "edit";
    phases = {
      plan: { answer: "The edit is withheld.", tools: [{ name: "Read", content: "keepMs: 10" }] },
      edit: {
        answer: "Done.", tools: [{ name: "Edit", content: "Updated" }],
        writes: {
          [fixture.targetFile]: "export default {\n  retryMs: 80,\n  keepMs: 10,\n};\n",
          [fixture.newFile]: "export const budget = { requestMs: 30000 };\n",
        },
      },
    };
  } else if (scenario === "v04-shell-ops") {
    fixture = buildFixture(scenario, workspace, { token: "SHELL9876" });
    const ticks = "tick 1\ntick 2\ntick 3\n";
    fs.writeFileSync(path.join(workspace, fixture.logFile), ticks);
    fs.writeFileSync(path.join(workspace, fixture.recordFile), "3\n");
    assert.equal(commitAll(workspace, fixture.commitSubject).status, 0);
    defaultPhase = "main";
    phases = {
      main: {
        answer: "Recorded three ticks and committed an isolated review.",
        tools: [
          { name: "Bash", input: { command: `node ${fixture.tickerScript} ${fixture.logFile}`, run_in_background: true }, content: "Started ticker" },
          { name: "Read", input: { file_path: fixture.logFile }, content: ticks },
        ],
      },
    };
  } else if (scenario === SCENARIOS.media) {
    fixture = buildFixture(scenario, workspace, { token: "RELEASE9876" });
    defaultPhase = "main";
    phases = {
      main: {
        answer: `Completed all four.\n${fixture.pdfToken}\n${fixture.pngToken}`,
        writes: {
          "src/greet.mjs": 'export const greeting = "Good morning";\n',
          VERSION: "0.2.0\n",
          "CHANGELOG.md": `${fixture.token}\n`,
          [fixture.notebookFile]: fs.readFileSync(path.join(workspace, fixture.notebookFile), "utf8")
            .replace("RATE = 0.05", `RATE = ${fixture.newRate}`),
        },
      },
    };
  } else if (scenario === SCENARIOS.cron) {
    fixture = {
      recordPath: "records/audit.md", auditToken: "AUDIT9876", hookLog: "hooks.log",
      commandName: "audit-command", skillName: "audit-skill",
      pluginCommandName: "plugin-command", pluginSkillName: "plugin-skill", pluginDir: slotDir,
      cronExpression: "0 1 1 1 *", cronPrompt: "Check audit token AUDIT9876",
    };
    defaultPhase = "main";
    phases = {
      main: {
        answer: "The command was denied.",
        init: { slash_commands: [fixture.commandName, fixture.pluginCommandName], skills: [fixture.skillName, fixture.pluginSkillName] },
        writes: { [fixture.recordPath]: "# Audit\nAUDIT9876\n", [fixture.hookLog]: "pre-tool-use fired\ndeny fired\n" },
      },
      cron: {
        answer: "aa1234ff",
        tools: [
          { name: "CronCreate", content: "Created aa1234ff" },
          { name: "CronList", content: `aa1234ff: ${fixture.cronPrompt}` },
        ],
      },
    };
  } else if (scenario === SCENARIOS.resume) {
    fixture = { buildId: "BUILD9876", deployWindow: "Thursday 02:00 UTC" };
    defaultPhase = "seed";
    phases = { seed: { answer: "noted." }, resume: { answer: fixture.buildId }, fork: { answer: fixture.deployWindow } };
  } else {
    fixture = { corpusFile: "report.txt", expectedDifference: 37 };
    fs.writeFileSync(path.join(workspace, fixture.corpusFile), "x".repeat(8000));
    defaultPhase = "corpus";
    phases = {
      corpus: { answer: "37", inputTokens: 4096, result: { structured_output: { difference: 37 } } },
      control: { answer: "ok", inputTokens: 32 },
    };
  }
  if (badPhase) phases[badPhase] = { ...phases[badPhase], ...defect };
  const specPath = path.join(slotDir, "fake-spec.json");
  fs.writeFileSync(specPath, JSON.stringify({ phases, defaultPhase }));
  const claudeBin = path.join(slotDir, "fake-cli.mjs");
  fs.writeFileSync(claudeBin, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const { phases, defaultPhase } = JSON.parse(fs.readFileSync(${JSON.stringify(specPath)}, "utf8"));
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(slotDir, "prompt.txt"))}, prompt);
const label = arg("--permission-mode") === "plan" ? "plan"
  : args.includes("--fork-session") ? "fork"
  : args.includes("--resume") ? "resume"
  : args.includes("--session-id") ? "seed"
  : prompt === "Reply with exactly: ok" ? "control"
  : prompt.startsWith("Use the CronCreate") ? "cron" : defaultPhase;
fs.writeFileSync(path.join(${JSON.stringify(slotDir)}, "prompt-" + label + ".txt"), prompt);
const spec = phases[label];
if (!spec) throw new Error("Unknown fake phase " + label);
for (const [name, text] of Object.entries(spec.writes ?? {})) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, text);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const originalId = args.includes("--session-id") ? arg("--session-id") : args.includes("--resume") ? arg("--resume") : "test-session";
const sessionId = label === "fork" && !spec.reuseSessionId ? originalId + "-fork" : originalId;
emit({ type: "system", subtype: "init", session_id: sessionId, ...spec.init });
const tools = spec.tools ?? [];
if (tools.length) {
  emit({ type: "assistant", message: { content: tools.map((tool, i) => ({ type: "tool_use", id: "tool-" + i, name: tool.name, input: tool.input ?? {} })) } });
  emit({ type: "user", message: { content: tools.map((tool, i) => ({ type: "tool_result", tool_use_id: "tool-" + i, content: tool.content })) } });
}
emit({ type: "assistant", message: { content: [{ type: "text", text: spec.answer }] } });
if (!spec.omitResult) emit({ type: "result", subtype: "success", is_error: false,
  session_id: sessionId, result: spec.answer, usage: { input_tokens: spec.inputTokens ?? 100 },
  modelUsage: { [spec.model ?? ${JSON.stringify(MODEL)}]: { inputTokens: 100 } }, ...spec.result });
`, { mode: 0o755 });
  return { fixture, slotDir, workspace, configDir, settingsPath, claudeBin, model: MODEL, frontendModel: MODEL, timeoutSeconds: 5, timeouts: { planTurnMs: 5000 } };
}

for (const scenario of Object.values(SCENARIOS)) {
  test(`${scenario}: all mandatory phases can pass`, async (t) => {
    const ctx = fakeContext(t, scenario);
    const result = await DRIVERS[scenario](ctx);
    assert.equal(result.outcome, "pass", result.reason);
    const labels = {
      [SCENARIOS.edit]: ["plan", "edit"],
      [SCENARIOS.media]: ["main"],
      [SCENARIOS.cron]: ["main", "cron"],
      [SCENARIOS.resume]: ["seed", "resume", "fork"],
      [SCENARIOS.corpus]: ["corpus", "control"],
    }[scenario];
    assert.deepEqual(Object.keys(result.evidence.phases), labels);
    for (const label of labels) {
      const phase = result.evidence.phases[label];
      assert.equal(phase.outcome, "pass");
      assert.equal(phase.completed, true);
      assert.equal(phase.pairing.ok, true);
      assert.equal(phase.model.ok, true);
      assert.equal(phase.envelope.ok, true);
      const transcriptLabel = ["edit", "corpus"].includes(label) ? "main" : label;
      assert.equal(phase.transcriptPath, path.join(ctx.slotDir, `transcript-${transcriptLabel}.jsonl`));
      assert.ok(fs.existsSync(phase.transcriptPath));
      assert.ok(result.checks.some((check) => check.name === `${label}: completed` && check.ok));
    }
  });
}

test("v09 prompts ask for literal deployment facts without tools or leaked follow-up answers", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.resume);
  const result = await DRIVERS[SCENARIOS.resume](ctx);
  assert.equal(result.outcome, "pass", result.reason);
  const prompts = Object.fromEntries(["seed", "resume", "fork"].map((phase) => [
    phase, fs.readFileSync(path.join(ctx.slotDir, `prompt-${phase}.txt`), "utf8"),
  ]));
  assert.ok(prompts.seed.includes(ctx.fixture.buildId));
  assert.ok(prompts.seed.includes(ctx.fixture.deployWindow));
  assert.match(prompts.seed, /literal/);
  assert.match(prompts.seed, /conversation only/);
  assert.match(prompts.seed, /Do not add or infer a calendar date/);
  for (const phase of ["seed", "resume", "fork"]) {
    assert.match(prompts[phase], /Do not use tools/);
    assert.match(prompts[phase], /persistent memory/);
    assert.equal(result.checks.find((check) => check.name === `${phase} used no tools`)?.ok, true);
  }
  for (const phase of ["resume", "fork"]) {
    assert.match(prompts[phase], /original .* from our conversation/);
    assert.ok(!prompts[phase].includes(ctx.fixture.buildId));
    assert.ok(!prompts[phase].includes(ctx.fixture.deployWindow));
  }
  assert.match(prompts.resume, /What is the example deployment's build id\?/);
  assert.match(prompts.fork, /What is the example deployment's deploy window\?/);
  assert.match(prompts.fork, /original weekday, time, and timezone/);
  assert.match(prompts.fork, /without adding a calendar date/);
});

test("v09 keeps a provider refusal failed even when the expected fact appears in the transcript", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.resume, "fork", {
    result: { is_error: true, stop_reason: "refusal", result: "The provider refused this request." },
  });
  const result = await DRIVERS[SCENARIOS.resume](ctx);
  assert.equal(result.outcome, "fail");
  assert.equal(result.checks.find((check) => check.name === "fork inherited the seed turn's context")?.ok, true);
  assert.equal(result.checks.find((check) => check.name === "fork: no error in result envelope")?.ok, false);
});

for (const phase of ["seed", "resume", "fork"]) {
  for (const tool of ["Write", "Read", "mcp__memory__create_entities"]) {
    test(`v09 rejects ${phase} persistent-memory tool ${tool} despite correct recall`, async (t) => {
      const ctx = fakeContext(t, SCENARIOS.resume, phase, {
        tools: [{
          name: tool,
          input: tool.startsWith("mcp__") ? { entities: [] } : { file_path: "memory/MEMORY.md" },
          content: "Deployment facts saved in persistent memory.",
        }],
      });
      const result = await DRIVERS[SCENARIOS.resume](ctx);
      assert.equal(result.outcome, "fail", result.reason);
      assert.equal(result.checks.find((check) => check.name === `${phase} used no tools`)?.ok, false);
      assert.equal(result.checks.find((check) => check.name === "recalls the build id")?.ok, true);
      assert.equal(result.checks.find((check) => check.name === "fork inherited the seed turn's context")?.ok, true);
      assert.equal(result.evidence.phases[phase].outcome, "pass", "tool-free recall is separate from transport health");
    });
  }
}

test("v09 accepts the original deploy window with existing comma and whitespace tolerance", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.resume, "fork", { answer: "Thursday,  02:00 UTC" });
  const result = await DRIVERS[SCENARIOS.resume](ctx);
  assert.equal(result.outcome, "pass", result.reason);
});

for (const [name, answer] of [
  ["invented calendar date", "Thursday 2026-09-24 02:00 UTC"],
  ["contradictory calendar date", "Thursday 2026-09-25 02:00 UTC"],
  ["wrong weekday", "Friday 02:00 UTC"],
  ["wrong hour", "Thursday 03:00 UTC"],
  ["wrong timezone", "Thursday 02:00 PST"],
]) {
  test(`v09 rejects a fork answer with ${name}`, async (t) => {
    const ctx = fakeContext(t, SCENARIOS.resume, "fork", { answer });
    const result = await DRIVERS[SCENARIOS.resume](ctx);
    assert.equal(result.outcome, "fail", result.reason);
    assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), [
      "fork inherited the seed turn's context",
    ]);
  });
}

test("v09 rejects an incorrect build id despite a correct fork answer", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.resume, "resume", { answer: "BUILD9875" });
  const result = await DRIVERS[SCENARIOS.resume](ctx);
  assert.equal(result.outcome, "fail", result.reason);
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), ["recalls the build id"]);
});

for (const [name, defect] of [
  ["the original session id", { reuseSessionId: true }],
  ["no session id", { init: { session_id: null }, result: { session_id: null } }],
]) {
  test(`v09 rejects a correct fork answer under ${name}`, async (t) => {
    const ctx = fakeContext(t, SCENARIOS.resume, "fork", defect);
    const result = await DRIVERS[SCENARIOS.resume](ctx);
    assert.equal(result.outcome, "fail", result.reason);
    assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), [
      "fork runs under a session id of its own",
    ]);
  });
}

const gitAt = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function shellWorktree(ctx, { branch = ctx.fixture.worktreeBranch, directory = "review", detached = false,
  marker = ctx.fixture.worktreeMarker, commit = true } = {}) {
  const dir = path.join(ctx.slotDir, directory);
  gitAt(ctx.workspace, "worktree", "add", "-q", ...(detached ? ["--detach"] : ["-b", branch]), dir);
  if (marker !== null) {
    fs.writeFileSync(path.join(dir, ctx.fixture.worktreeFile), `${marker}\n`);
    if (commit) {
      gitAt(dir, "add", "--", ctx.fixture.worktreeFile);
      gitAt(dir, "commit", "-q", "-m", "chore: add review marker");
    }
  }
  return dir;
}

function nativeWorktreeTranscript(ctx, dir) {
  const specPath = path.join(ctx.slotDir, "fake-spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  spec.phases.main.tools.push({
    name: "EnterWorktree", input: { name: ctx.fixture.worktreeBranch },
    content: `Created worktree at ${dir} on branch worktree-review+SHELL9876.`,
  }, { name: "ExitWorktree", input: { action: "keep" }, content: "Exited worktree. Your work is preserved." });
  fs.writeFileSync(specPath, JSON.stringify(spec));
}

for (const [name, options] of [
  ["direct Git worktree", {}],
  ["native worktree branch", { branch: "worktree-review+SHELL9876", directory: "workspace/.claude/worktrees/review+SHELL9876" }],
  ["worktree path with spaces and a newline", { directory: "review path\nwith newline" }],
]) {
  test(`v04 accepts a committed marker in a ${name}`, async (t) => {
    const ctx = fakeContext(t, "v04-shell-ops");
    const dir = shellWorktree(ctx, options);
    if (options.branch) nativeWorktreeTranscript(ctx, dir);
    const result = await DRIVERS["v04-shell-ops"](ctx);
    assert.equal(result.outcome, "pass", result.reason);
    assert.equal(result.evidence.phases.main.outcome, "pass");
    assert.equal(result.evidence.selectedWorktree.realPath, fs.realpathSync(dir));
    assert.equal(result.evidence.selectedWorktree.branch, `refs/heads/${options.branch ?? ctx.fixture.worktreeBranch}`);
    const prompt = fs.readFileSync(path.join(ctx.slotDir, "prompt.txt"), "utf8");
    assert.ok(prompt.includes(ctx.fixture.worktreeBranch));
    assert.ok(prompt.includes("worktree-review+SHELL9876"));
    assert.ok(prompt.includes('ExitWorktree with action "keep"'));
  });
}

test("v04 permits an unrelated worktree without using its evidence", async (t) => {
  const ctx = fakeContext(t, "v04-shell-ops");
  shellWorktree(ctx);
  shellWorktree(ctx, { branch: "unrelated", directory: "other", marker: "UNRELATED" });
  const result = await DRIVERS["v04-shell-ops"](ctx);
  assert.equal(result.outcome, "pass", result.reason);
});

for (const branch of ["review/OTHER9876", "review/SHELL9876-extra", "review/SHELL98760",
  "worktree-review+SHELL9876-extra", "worktree-reviewSHELL9876"]) {
  test(`v04 rejects the nonmatching branch ${branch}`, async (t) => {
    const ctx = fakeContext(t, "v04-shell-ops");
    shellWorktree(ctx, { branch });
    const result = await DRIVERS["v04-shell-ops"](ctx);
    assert.equal(result.outcome, "fail", result.reason);
    assert.ok(result.checks.some((check) => check.name === "a second worktree is registered on its own branch" && !check.ok));
  });
}

for (const [name, prepare] of [
  ["a branch and successful native transcript without a second checkout", (ctx) => {
    gitAt(ctx.workspace, "branch", ctx.fixture.worktreeBranch);
    nativeWorktreeTranscript(ctx, path.join(ctx.workspace, ".claude/worktrees/review+SHELL9876"));
  }],
  ["a detached secondary checkout", (ctx) => shellWorktree(ctx, { detached: true })],
  ["the expected branch name only in a path", (ctx) => shellWorktree(ctx, { branch: "unrelated", directory: "review/SHELL9876" })],
  ["a removed secondary checkout", (ctx) => fs.rmSync(shellWorktree(ctx), { recursive: true, force: true })],
  ["both accepted branches as ambiguous candidates", (ctx) => {
    shellWorktree(ctx);
    shellWorktree(ctx, { branch: "worktree-review+SHELL9876", directory: "native-review" });
  }],
  ["the marker only in an unrelated worktree", (ctx) => {
    shellWorktree(ctx, { marker: null });
    shellWorktree(ctx, { branch: "unrelated", directory: "other" });
  }],
  ["a missing marker", (ctx) => shellWorktree(ctx, { marker: null })],
  ["a different marker token", (ctx) => shellWorktree(ctx, { marker: "REVIEWED-OTHER9876" })],
  ["a marker token with an extra suffix", (ctx) => shellWorktree(ctx, { marker: `${ctx.fixture.worktreeMarker}0` })],
  ["an uncommitted marker", (ctx) => shellWorktree(ctx, { commit: false })],
  ["a committed marker deleted from disk", (ctx) => fs.unlinkSync(path.join(shellWorktree(ctx), ctx.fixture.worktreeFile))],
  ["a committed marker with uncommitted edits", (ctx) => fs.appendFileSync(path.join(shellWorktree(ctx), ctx.fixture.worktreeFile), "uncommitted edit\n")],
  ["a marker leaked into the primary working tree", (ctx) => {
    shellWorktree(ctx);
    fs.writeFileSync(path.join(ctx.workspace, ctx.fixture.worktreeFile), ctx.fixture.worktreeMarker);
  }],
  ["a primary committed marker hidden by a working-tree deletion", (ctx) => {
    shellWorktree(ctx);
    fs.writeFileSync(path.join(ctx.workspace, ctx.fixture.worktreeFile), ctx.fixture.worktreeMarker);
    gitAt(ctx.workspace, "add", "--", ctx.fixture.worktreeFile);
    gitAt(ctx.workspace, "commit", "-q", "-m", "chore: leaked marker");
    fs.unlinkSync(path.join(ctx.workspace, ctx.fixture.worktreeFile));
  }],
  ["an unreadable Git registry", (ctx) => {
    shellWorktree(ctx);
    fs.renameSync(path.join(ctx.workspace, ".git"), path.join(ctx.slotDir, "saved-git"));
  }],
]) {
  test(`v04 rejects ${name}`, async (t) => {
    const ctx = fakeContext(t, "v04-shell-ops");
    prepare(ctx);
    const result = await DRIVERS["v04-shell-ops"](ctx);
    assert.equal(result.evidence.phases.main.outcome, "pass", "only filesystem evidence should fail");
    assert.equal(result.outcome, "fail", result.reason);
  });
}

test("worktree porcelain preserves path bytes and optional record fields", () => {
  const head = "a".repeat(40);
  const pathname = '/workspace with spaces/"review"\nnext line';
  const output = `worktree ${pathname}\0HEAD ${head}\0branch refs/heads/worktree-review+TOKEN\0locked reason with\na newline\0\0` +
    `worktree /removed\0HEAD ${head}\0detached\0prunable gitdir file points to non-existent location\0\0`;
  assert.deepEqual(parseWorktreeList(output), [
    { path: pathname, head, branch: "refs/heads/worktree-review+TOKEN", detached: false, prunable: false },
    { path: "/removed", head, branch: null, detached: true, prunable: true },
  ]);
});

test("worktree porcelain rejects missing, duplicate and truncated fields", () => {
  const head = "a".repeat(40);
  const valid = `worktree /workspace\0HEAD ${head}\0branch refs/heads/review/TOKEN\0\0`;
  for (const output of [
    "", valid.slice(0, -1), valid.slice(0, -2), valid.replace(`HEAD ${head}\0`, ""),
    valid.replace("branch refs/heads/review/TOKEN\0", ""), valid.replace(head, "unknown"),
    valid.replace("worktree /workspace", "worktree relative/path"),
    valid.replace("branch refs/heads/review/TOKEN", "branch review/TOKEN"),
    valid.replace("\0\0", "\0detached\0\0"), valid.replace("\0\0", `\0HEAD ${head}\0\0`),
    valid.slice(0, -1) + valid,
  ]) assert.equal(parseWorktreeList(output), null, JSON.stringify(output));
});

async function driversWithProcess(slotDir, stub) {
  const driverUrl = new URL("../scripts/verify/drivers.mjs", import.meta.url);
  const source = fs.readFileSync(driverUrl, "utf8").replace(/from "(\.\/[^\"]+)";/g, (_match, specifier) =>
    `from ${JSON.stringify(specifier === "./process.mjs" ? pathToFileURL(stub).href : new URL(specifier, driverUrl).href)};`);
  const isolatedPath = path.join(slotDir, "drivers.mjs");
  fs.writeFileSync(isolatedPath, source);
  return (await import(pathToFileURL(isolatedPath).href)).DRIVERS;
}

for (const [command, checkName] of [
  ["worktree", "git worktree registry is readable"],
  ["show", "the worktree marker is committed unchanged"],
  ["ls-tree", "the marker file is absent from the primary checkout"],
]) {
  test(`v04 rejects incomplete git ${command} despite successful-looking output`, async (t) => {
    const ctx = fakeContext(t, "v04-shell-ops");
    shellWorktree(ctx);
    const stub = path.join(ctx.slotDir, "fake-process.mjs");
    fs.writeFileSync(stub, `
import { runProcess as realRunProcess } from ${JSON.stringify(new URL("../scripts/verify/process.mjs", import.meta.url).href)};
export async function runProcess(file, args, options) {
  const out = await realRunProcess(file, args, options);
  return file === "git" && args[0] === ${JSON.stringify(command)}
    ? { ...out, completed: false, timedOut: true, error: new Error("Command timed out") } : out;
}
`);
    const drivers = await driversWithProcess(ctx.slotDir, stub);
    const result = await drivers["v04-shell-ops"](ctx);
    assert.equal(result.outcome, "fail", result.reason);
    assert.ok(result.checks.some((check) => check.name === checkName && !check.ok));
  });
}

test("multi-step media prompt states the format without disclosing either random token", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.media);
  const result = await DRIVERS[SCENARIOS.media](ctx);
  assert.equal(result.outcome, "pass", result.reason);
  const prompt = fs.readFileSync(path.join(ctx.slotDir, "prompt.txt"), "utf8");
  assert.match(prompt, /exactly 12 characters: a six-letter uppercase prefix/);
  assert.match(prompt, /six uppercase hexadecimal characters \(0-9, A-F\)/);
  for (const token of [ctx.fixture.pdfToken, ctx.fixture.pngToken]) {
    assert.equal(token.length, 12);
    assert.ok(!prompt.includes(token));
    assert.ok(!prompt.includes(token.slice(-6)));
  }
});

const flipGlyph = (char) => (char === "0" ? "D" : "0");

test("multi-step still fails a misread image token when every other check passes", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.media);
  const specPath = path.join(ctx.slotDir, "fake-spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const token = ctx.fixture.pngToken;
  const wrongToken = token.slice(0, -2) + flipGlyph(token.at(-2)) + flipGlyph(token.at(-1));
  spec.phases.main.answer = `Completed all four.\n${ctx.fixture.pdfToken}\n${wrongToken}`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const result = await DRIVERS[SCENARIOS.media](ctx);
  assert.equal(result.outcome, "fail");
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), ["the image's token came back"]);
});

test("multi-step passes one misread image glyph and names it in the check", async (t) => {
  const ctx = fakeContext(t, SCENARIOS.media);
  const specPath = path.join(ctx.slotDir, "fake-spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const token = ctx.fixture.pngToken;
  const misread = token.slice(0, -1) + flipGlyph(token.at(-1));
  spec.phases.main.answer = `Completed all four.\n${ctx.fixture.pdfToken}\n${misread}`;
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const result = await DRIVERS[SCENARIOS.media](ctx);
  assert.equal(result.outcome, "pass", result.reason);
  const check = result.checks.find((c) => c.name === "the image's token came back");
  assert.equal(check.detail, `read ${misread} for ${token}: one glyph misread`);
});

for (const [field, label] of [["pdfToken", "PDF"], ["pngToken", "image"]]) {
  for (const part of ["prefix", "suffix"]) {
    test(`multi-step rejects an omitted ${label} ${part} character`, async (t) => {
      const ctx = fakeContext(t, SCENARIOS.media);
      const specPath = path.join(ctx.slotDir, "fake-spec.json");
      const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
      const token = ctx.fixture[field];
      const index = part === "prefix" ? 2 : 6;
      const shortened = token.slice(0, index) + token.slice(index + 1);
      spec.phases.main.answer = `Completed all four.\n${["pdfToken", "pngToken"]
        .map((key) => key === field ? shortened : ctx.fixture[key]).join("\n")}`;
      fs.writeFileSync(specPath, JSON.stringify(spec));
      const result = await DRIVERS[SCENARIOS.media](ctx);
      assert.equal(result.outcome, "fail");
      assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), [`the ${label}'s token came back`]);
    });
  }
}

for (const [scenario, phase, defect] of [
  [SCENARIOS.edit, "plan", { result: { is_error: true } }],
  [SCENARIOS.cron, "cron", { result: { is_error: true } }],
  [SCENARIOS.resume, "seed", { model: "wrong-model" }],
  [SCENARIOS.resume, "fork", { omitResult: true }],
  [SCENARIOS.corpus, "control", { omitResult: true }],
]) {
  test(`${scenario}: expected evidence cannot hide a bad ${phase} phase`, async (t) => {
    const ctx = fakeContext(t, scenario, phase, defect);
    const result = await DRIVERS[scenario](ctx);
    assert.notEqual(result.outcome, "pass", "the mandatory phase failed after producing the expected evidence");
    assert.match(result.reason, new RegExp(`\\b${phase}:`));
    if (phase === "control") {
      assert.equal(result.evidence.delta, null, "a failed baseline must never inflate the token delta");
      assert.ok(!result.checks.some((check) => check.name === "whole corpus reached the model" && check.ok));
    }
  });
}

for (const [name, fields, resultPatch, extraEvents, outcome] of [
  ["timeout after evidence", { timedOut: true }, {}, [], "blocked"],
  ["missing result", { omitResult: true }, {}, [], "blocked"],
  ["unanswered tool", {}, {}, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "unanswered", name: "Read", input: {} }] } }], "blocked"],
  ["orphaned tool result", {}, {}, [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "expected evidence" }] } }], "blocked"],
  ["wrong model", {}, { modelUsage: { "another-model": {} } }, [], "blocked"],
  ["error envelope", {}, { is_error: true }, [], "fail"],
  ["missing stop reason", {}, { subtype: null }, [], "fail"],
  ["missing input usage", {}, { usage: {} }, [], "fail"],
]) {
  test(`mandatory phase rejects ${name}`, () => {
    const result = { type: "result", subtype: "success", is_error: false, result: "expected evidence",
      usage: { input_tokens: 100 }, modelUsage: { [MODEL]: {} }, ...resultPatch };
    const run = new HeadlessRun({
      events: [{ type: "assistant", message: { content: [{ type: "text", text: "expected evidence" }] } },
        ...extraEvents, ...(fields.omitResult ? [] : [result])],
      exitCode: 0, signal: null, stderr: "", spawnError: null, timedOut: false, durationMs: 25,
      transcriptPath: "/offline/transcript.jsonl", ...fields,
    });
    for (const label of ["plan", "edit", "main", "cron", "seed", "resume", "fork", "corpus", "control"]) {
      const phase = phaseVerdict(label, run, { model: MODEL, frontendModel: MODEL });
      assert.equal(phase.outcome, outcome, phase.reason);
      assert.ok(phase.reason.startsWith(`${label}:`));
      assert.ok(phase.checks.every((check) => check.name.startsWith(`${label}:`)));
      assert.equal(phase.evidence.transcriptPath, run.transcriptPath);
    }
  });
}

test("a missing mandatory phase is blocked", () => {
  const phase = phaseVerdict("fork", null, { model: MODEL });
  assert.equal(phase.outcome, "blocked");
  assert.match(phase.reason, /^fork: phase did not run$/);
  assert.equal(phase.evidence.completed, false);
});

async function fakeDaemon(t, faultAt = 0, fault = "timeout", { missingOutput = false, invalidState = false } = {}) {
  const slotDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-daemon-driver-test-"));
  t.after(() => fs.rmSync(slotDir, { recursive: true, force: true }));
  const workspace = path.join(slotDir, "workspace");
  const configDir = path.join(slotDir, "config");
  fs.mkdirSync(workspace);
  fs.mkdirSync(configDir);
  const fixture = {
    channelFile: "channel.txt", channelValue: "CHANNEL9876", backgroundResult: "result.txt",
    buildFile: "build.txt", buildNumber: "4321",
  };
  const stub = path.join(slotDir, "fake-process.mjs");
  fs.writeFileSync(stub, `
import fs from "node:fs";
import path from "node:path";
const fixture = ${JSON.stringify(fixture)};
let running = false;
let settingsCount = 0;
export const calls = [];
export async function runProcess(file, args, { cwd, env }) {
  calls.push({ file, args });
  const daemon = env.GHCP_DAEMON_DIR;
  const name = path.basename(file);
  let stdout = "";
  if (name === "claude-ghcp") {
    if (args.includes("--background")) {
      running = true;
      if (!${missingOutput}) fs.writeFileSync(path.join(cwd, fixture.backgroundResult), fixture.channelValue);
      for (const file of ["bridge.json", "bridge.log"]) fs.writeFileSync(path.join(daemon, file), "fixture");
      fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "daemon.log"), "native worker started");
      const jobDir = path.join(env.CLAUDE_CONFIG_DIR, "jobs", "abcdef12");
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(path.join(jobDir, "state.json"), ${invalidState}
        ? "PRIVATE_DIAGNOSTIC_SENTINEL invalid JSON"
        : JSON.stringify({
          state: ${missingOutput} ? "working" : "idle",
          detail: ${missingOutput} ? "starting..." : "completed",
          createdAt: "2026-09-22T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:01.000Z",
          providerEnv: { ANTHROPIC_AUTH_TOKEN: "PRIVATE_DIAGNOSTIC_SENTINEL" },
          ptyAuth: "PRIVATE_DIAGNOSTIC_SENTINEL",
        }));
      stdout = "backgrounded · abcdef12";
    } else if (args.includes("-p")) stdout = fixture.buildNumber;
    if (!args.includes("-p")) {
      fs.mkdirSync(path.join(daemon, "settings"), { recursive: true });
      fs.writeFileSync(path.join(daemon, "settings", String(settingsCount++)), "{}");
    }
  } else if (name === "claude-ghcp-status") {
    stdout = JSON.stringify({ running, pid: 12345, port: 45678, model: ${JSON.stringify(MODEL)} });
  } else if (name === "claude-ghcp-stop") {
    running = false;
    for (const file of ["bridge.json", "bridge.log"]) fs.rmSync(path.join(daemon, file), { force: true });
    stdout = JSON.stringify({ stopped: true });
  } else if (args[0] === "agents") {
    stdout = JSON.stringify([{ id: "abcdef12", kind: "background", status: "idle", cwd }]);
  }
  const out = { status: 0, signal: null, stdout, stderr: "", completed: true, timedOut: false, aborted: false };
  if (calls.length === ${faultAt}) {
    if (${JSON.stringify(fault)} === "malformed") out.stdout = "not-json";
    else Object.assign(out, { completed: false, timedOut: true, error: new Error("Command timed out") });
  }
  return out;
}
`);
  const isolatedDrivers = await driversWithProcess(slotDir, stub);
  const { calls } = await import(pathToFileURL(stub).href);
  const result = await isolatedDrivers["v11-daemon-background"]({
    fixture, slotDir, workspace, configDir, model: MODEL, claudeBin: path.join(slotDir, "fake-cli"),
    ...(missingOutput ? { timeouts: {
      backgroundLaunchMs: 1000, foregroundLaunchMs: 1000, persistentLaunchMs: 1000, detachedOutputMs: 1,
    } } : {}),
  });
  return { result, calls, slotDir };
}

test("v11 preserves command and daemon logs before cleanup without exposing private job fields", async (t) => {
  const { result, slotDir } = await fakeDaemon(t);
  assert.equal(result.outcome, "pass", result.reason);
  const { commands, daemonDiagnostics } = result.evidence;
  const launch = commands["background launch"];
  assert.equal(fs.readFileSync(path.join(slotDir, launch.stdoutFile), "utf8"), "backgrounded · abcdef12");
  assert.equal(fs.readFileSync(path.join(slotDir, launch.stderrFile), "utf8"), "");
  assert.equal(fs.statSync(path.join(slotDir, launch.stdoutFile)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(slotDir, daemonDiagnostics.logs["daemon-bridge.log"]), "utf8"), "fixture");
  assert.equal(fs.readFileSync(path.join(slotDir, daemonDiagnostics.logs["claude-daemon.log"]), "utf8"), "native worker started");
  assert.equal(fs.statSync(path.join(slotDir, "daemon-bridge.log")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(slotDir, "daemon", "bridge.log")), false);
  assert.deepEqual(Object.keys(daemonDiagnostics.backgroundState), ["state", "detail", "createdAt", "updatedAt"]);
  assert.doesNotMatch(JSON.stringify(daemonDiagnostics), /PRIVATE_DIAGNOSTIC_SENTINEL|providerEnv|ptyAuth/);
});

test("v11 records native startup stalls without accepting a successful launcher as completed work", async (t) => {
  const { result, calls } = await fakeDaemon(t, 0, "timeout", { missingOutput: true });
  assert.equal(result.outcome, "fail");
  assert.match(result.reason, /detached agent wrote.*file never appeared/);
  assert.equal(result.evidence.daemonDiagnostics.backgroundState.state, "working");
  assert.equal(result.evidence.daemonDiagnostics.backgroundState.detail, "starting...");
  assert.equal(result.evidence.commands["background launch"].completed, true);
  assert.equal(calls.length, 11, "cleanup must still run after missing output");
});

test("v11 surfaces corrupt diagnostic state without leaking its contents or skipping cleanup", async (t) => {
  const { result, calls } = await fakeDaemon(t, 0, "timeout", { invalidState: true });
  assert.equal(result.outcome, "fail");
  assert.match(result.reason, /daemon diagnostics preserved: background state: SyntaxError/);
  assert.doesNotMatch(JSON.stringify(result.evidence.daemonDiagnostics), /PRIVATE_DIAGNOSTIC_SENTINEL/);
  assert.equal(calls.length, 11, "cleanup must still run after diagnostic errors");
});

test("v11 rejects incomplete commands even when their evidence and exit status look successful", async (t) => {
  const labels = ["background launch", "initial status", "agent roster", "foreground launch",
    "foreground status", "persistent launch", "persistent status", "daemon stop", "stopped status"];
  const valid = await fakeDaemon(t);
  assert.equal(valid.result.outcome, "pass", valid.result.reason);
  assert.deepEqual(Object.keys(valid.result.evidence.commands), labels);
  for (const [index, label] of labels.entries()) {
    const { result, calls } = await fakeDaemon(t, index + 1);
    assert.equal(result.outcome, "fail", `${label} must not pass after a timeout`);
    assert.ok(result.reason.includes(`${label}: command completed`), result.reason);
    assert.equal(result.evidence.commands[label].status, 0);
    assert.equal(result.evidence.commands[label].timedOut, true);
    assert.equal(calls.length, 11, "cleanup must still run");
  }
});

test("v11 requires a valid final status rather than treating missing status as stopped", async (t) => {
  const { result } = await fakeDaemon(t, 9, "malformed");
  assert.equal(result.outcome, "fail");
  assert.ok(result.reason.includes("stopped status: status has a running flag"), result.reason);
});

test("v11 awaits the async helper at every command and cleanup site", () => {
  const source = DRIVERS["v11-daemon-background"].toString();
  assert.doesNotMatch(source, /\bspawnSync\s*\(/);
  assert.match(source, /const sh\s*=[\s\S]*?runProcess\s*\(/);
  const calls = [...source.matchAll(/\b(?:sh|status)\s*\(/g)];
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(source.slice(0, call.index), /\bawait\s*$/, `unawaited command: ${source.slice(call.index, call.index + 50)}`);
  }
});

test("the served-model check ignores the [1m] window hint but still rejects another model", () => {
  const served = (...keys) => new HeadlessRun({
    events: [{ type: "result", modelUsage: Object.fromEntries(keys.map((key) => [key, {}])) }],
  });
  // Usage keys exactly as a 1M matrix run reported them.
  for (const [model, frontendModel, key] of [
    ["claude-opus-5.5", "claude-opus-5-5[1m]", "claude-opus-5-5[1m]"],
    ["claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-5[1m]"],
    ["claude-haiku-4.5", "claude-haiku-4-5", "claude-haiku-4-5"],
    ["gpt-6-astra", "github-copilot/claude-gpt-6-astra[1m]", "github-copilot/claude-gpt-6-astra[1m]"],
    // A launch id with the hint still matches a usage key without it, and back.
    ["claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-5"],
    ["claude-opus-5.5", "claude-opus-5-5", "claude-opus-5-5[1m]"],
  ]) {
    const verdict = servedExpectedModel(served(key), { model, frontendModel });
    assert.ok(verdict.ok, `${frontendModel} vs ${key}: ${verdict.reason}`);
  }
  const wrong = servedExpectedModel(served("claude-sonnet-5[1m]"), { model: "claude-opus-5.5", frontendModel: "claude-opus-5-5[1m]" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /claude-sonnet-5\[1m\], expected claude-opus-5\.5/);
});

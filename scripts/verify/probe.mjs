#!/usr/bin/env node
/**
 * Capability probe.
 *
 * Answers one question per probe: does this Claude Code build, driven through
 * this bridge, actually offer the capability -- and can a driver judge it from
 * primary evidence?
 *
 * The matrix's feature inventory used to answer that by asking a model what
 * tools it had. Model prose is exactly what the rest of this suite refuses to
 * accept, and it was deciding the denominator. This runs the capability
 * instead and reads what came back.
 *
 * Usage:
 *   node scripts/verify/probe.mjs
 *   node scripts/verify/probe.mjs --model claude-haiku-4.5 --only plan-mode,cron
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isEntryPoint } from "../../src/entry-point.mjs";
import {
  ROOT_DIR,
  assertModelServed,
  claudeVersion,
  resolveClaudeBin,
  seedConfigDir,
  startBridge,
  writeLaunchSettings,
} from "./bridge.mjs";
import { mentionsToken } from "./drivers.mjs";
import { buildPdf, buildPng } from "./media.mjs";
import { runHeadless } from "./session.mjs";

const PERMISSION_ARGS = ["--permission-mode", "bypassPermissions"];

/* ------------------------------------------------------------------ *
 * Fixture helpers
 * ------------------------------------------------------------------ */

const write = (dir, rel, body) => {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
};

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

export const PROBES = {
  /**
   * Plan mode must do two things: refuse the edit, and still finish the turn.
   * A build that hangs waiting for plan approval is unusable headless, and
   * that is indistinguishable from "refused" unless the result event is
   * checked too.
   */
  "plan-mode": {
    fixture(dir) {
      write(dir, "config.mjs", "export const retries = 3;\n");
      return {};
    },
    prompt: "Change retries to 9 in config.mjs.",
    permissionMode: "plan",
    judge(run, { workspace }) {
      const body = fs.readFileSync(path.join(workspace, "config.mjs"), "utf8");
      return {
        completed: run.completed,
        fileUnchanged: body.includes("retries = 3"),
        wrote: !body.includes("retries = 3"),
        stopReason: run.result?.stop_reason ?? run.result?.subtype ?? null,
        tools: run.toolNames(),
      };
    },
  },

  /**
   * A plugin is project surface the model can only have from --plugin-dir.
   * Advertisement in init is the evidence; a plugin that loads but is never
   * offered to the model is not loaded for our purposes.
   */
  plugins: {
    fixture(dir) {
      const root = path.join(dir, "probe-plugin");
      write(
        root,
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "probe-plugin", version: "0.1.0", description: "Capability probe plugin" }, null, 2) + "\n",
      );
      write(
        root,
        "commands/probe-ping.md",
        "---\ndescription: Probe command supplied by a plugin\n---\n\nReply with exactly: PLUGIN-PONG\n",
      );
      write(
        root,
        "skills/probe-style/SKILL.md",
        "---\nname: probe-style\ndescription: Probe skill supplied by a plugin. Use when asked about probe style.\n---\n\n# Probe style\n\nAlways answer in one word.\n",
      );
      return { pluginDir: root };
    },
    prompt: "List nothing. Reply with exactly: ready.",
    extraArgs: (fixture) => ["--plugin-dir", fixture.pluginDir],
    judge(run) {
      const commands = JSON.stringify(run.init?.slash_commands ?? []);
      const skills = JSON.stringify(run.init?.skills ?? run.init?.available_skills ?? []);
      return {
        completed: run.completed,
        commandAdvertised: commands.includes("probe-ping"),
        skillAdvertised: skills.includes("probe-style"),
        initKeys: Object.keys(run.init ?? {}),
      };
    },
  },

  /**
   * Cron in a headless turn cannot be judged on the job firing -- the
   * scheduler only runs while the REPL is idle. What is judgeable is whether
   * the tool exists, accepts a schedule, and the job comes back from a list.
   */
  cron: {
    fixture() {
      return {};
    },
    prompt:
      "Use the CronCreate tool to schedule a one-shot reminder with the cron expression `37 4 1 1 *` " +
      "and the prompt `probe reminder`. Then call CronList. " +
      "Reply with exactly the job id CronCreate returned, or `NO-CRON-TOOL` if you have no such tool.",
    judge(run) {
      return {
        completed: run.completed,
        createCalled: run.usedTool("CronCreate"),
        listCalled: run.usedTool("CronList"),
        answer: run.answer.slice(0, 160),
        tools: run.toolNames(),
      };
    },
  },

  /**
   * Structured output is a wire-format change on the result envelope, which is
   * precisely where a translating bridge is most likely to drop something.
   */
  "structured-output": {
    fixture(dir) {
      write(dir, "VERSION", "2.4.1\n");
      return {};
    },
    prompt: "Read VERSION and report the version string it holds.",
    extraArgs: () => [
      "--json-schema",
      JSON.stringify({
        type: "object",
        properties: { version: { type: "string" } },
        required: ["version"],
        additionalProperties: false,
      }),
    ],
    judge(run) {
      const result = run.result;
      const candidates = [result?.structured_output, result?.structuredOutput, result?.result];
      let parsed = null;
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object") { parsed = candidate; break; }
        if (typeof candidate === "string") {
          try { parsed = JSON.parse(candidate); break; } catch {}
        }
      }
      return {
        completed: run.completed,
        resultKeys: Object.keys(result ?? {}),
        parsedShape: parsed ? Object.keys(parsed) : null,
        versionMatches: parsed?.version === "2.4.1",
        rawResult: String(result?.result ?? "").slice(0, 200),
      };
    },
  },

  /**
   * Read on a PDF and on a PNG both put a non-text content block into a
   * tool_result. That block is the thing a text-only translation layer drops.
   */
  multimodal: {
    fixture(dir) {
      // Both tokens are drawn here and rasterised -- into a PDF page and into
      // a PNG -- so the only way to report one is to have received the bytes.
      //
      // Separator-free, exactly as fixtures.mjs draws the v05 pair, and for
      // the same measured reason: the image is read by segmenting glyphs, and
      // two models made the identical mis-read of a rasterised prefix where
      // only the separator they happened to type ("IMG TAG" vs "IMG-TAG")
      // decided which passed. A render-width check cannot catch this -- "-"
      // HAS a glyph in media.mjs and rasterises at full cell width -- so the
      // token alphabet is the only thing keeping separators out. Hex holds
      // every character inside the block font, and a byte count fixes the
      // width so a short draw cannot leave a needle that matches anything.
      const mediaToken = () => randomBytes(3).toString("hex").toUpperCase();
      const pdfToken = `PDFDOC${mediaToken()}`;
      const pngToken = `IMGTAG${mediaToken()}`;
      fs.writeFileSync(path.join(dir, "invoice.pdf"), buildPdf(pdfToken));
      fs.writeFileSync(path.join(dir, "banner.png"), buildPng(pngToken));
      return { pdfToken, pngToken };
    },
    prompt:
      "Read invoice.pdf and banner.png. Reply with exactly two lines: the token written in the PDF " +
      "on the first line, and the token shown in the PNG on the second. No other text.",
    judge(run, { fixture }) {
      const answer = run.answer;
      return {
        completed: run.completed,
        readCalled: run.usedTool("Read"),
        // mentionsToken, not a bare includes: a model that read the raster and
        // typed "IMGTAG E51B5C" got it right, and a bare includes fails it on
        // the space alone. Six hex characters of entropy are what stop the
        // forgiveness handing out a pass nobody earned.
        pdfToken: mentionsToken(answer, fixture.pdfToken),
        pngToken: mentionsToken(answer, fixture.pngToken),
        answer: answer.slice(0, 200),
        toolResultErrors: run.toolResults.filter((r) => r.isError).map((r) => r.content.slice(0, 120)),
      };
    },
  },

  /**
   * A worktree is a second checkout of one repository. Whether this build ships
   * a dedicated tool or leaves it to git, what a driver can judge is the same:
   * the worktree exists, on its own branch, and the file written inside it is
   * absent from the primary checkout.
   */
  worktree: {
    // Outside the repo tree. `.verify-runs/` sits inside this checkout, so a
    // fixture repo created there is nested in the real one, and the worktree
    // this probe asks for lands at `../probe-wt` -- a path belonging to the
    // outer repo, not the fixture. Run under bypassPermissions, that resolved
    // to the real repository: it took a commit onto the working branch and
    // left a `probe/wt` branch behind. A temp dir has no parent repo to
    // escape into.
    isolate: true,
    fixture(dir) {
      write(dir, "README.md", "# Probe\n");
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "Probe"]);
      git(["config", "user.email", "probe@example.invalid"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "chore: seed"]);
      return {};
    },
    prompt:
      "Create a git worktree of this repository at ../probe-wt on a new branch named probe/wt. " +
      "Inside that worktree, create a file ONLY-THERE.md containing the word ISOLATED, and commit it there. " +
      "Do not add that file to the main checkout. Reply with exactly: done.",
    judge(run, { workspace }) {
      const list = spawnSync("git", ["worktree", "list"], { cwd: workspace, encoding: "utf8" }).stdout ?? "";
      const wtPath = path.join(path.dirname(workspace), "probe-wt");
      return {
        completed: run.completed,
        worktreeTools: run.toolNames().filter((n) => /worktree/i.test(n)),
        worktreeRegistered: list.split("\n").filter(Boolean).length > 1,
        fileInWorktree: fs.existsSync(path.join(wtPath, "ONLY-THERE.md")),
        fileAbsentFromMain: !fs.existsSync(path.join(workspace, "ONLY-THERE.md")),
        list: list.trim().split("\n").slice(0, 4),
      };
    },
  },

  /**
   * ABSENT_TOOLS in features.mjs shrinks the coverage denominator, so what it
   * rests on has to be primary evidence -- and neither available source of a
   * tool list qualifies. Model prose is what the suite refuses everywhere else.
   * The init `tools` list is the eagerly-loaded set only: Glob and Grep are
   * missing from it yet answer fine when called.
   *
   * The stream settles it. A tool the build does not offer can never produce a
   * tool_use block, however firmly it is asked for, so an attempted call is the
   * measurement. init.tools rides along as reference data, never as the
   * verdict.
   */
  "todo-write": {
    fixture() {
      return {};
    },
    prompt:
      "Use the TodoWrite tool to record a todo list containing exactly one item: `probe item`. " +
      "Then reply with exactly: done. " +
      "If you have no TodoWrite tool, reply with exactly: NO-TODO-TOOL.",
    judge(run) {
      return {
        completed: run.completed,
        called: run.usedTool("TodoWrite"),
        errors: run.toolResults.filter((r) => r.isError).map((r) => r.content.slice(0, 120)),
        answer: run.answer.slice(0, 120),
        tools: run.toolNames(),
        initTools: run.init?.tools ?? null,
      };
    },
  },

  /**
   * BashOutput and KillShell only exist relative to a live background shell, so
   * one is started first. The ticker bounds its own life: if KillShell turns
   * out to be absent, the fixture still cannot outlive the probe.
   *
   * The prompt spends its length forbidding the model to stop and ask. Left to
   * itself it noticed the follow-up tools were missing, declined to start the
   * shell at all, and offered alternatives -- which measures nothing, because
   * `backgrounded` is the precondition that makes the other two judgeable.
   */
  "background-shell": {
    fixture(dir) {
      write(
        dir,
        "ticker.mjs",
        "let n = 0;\n" +
          "const t = setInterval(() => { console.log(`tick ${++n}`); }, 500);\n" +
          "setTimeout(() => { clearInterval(t); process.exit(0); }, 60_000);\n",
      );
      return {};
    },
    prompt:
      "Carry out all three steps in order. Do not ask me anything and do not stop early, " +
      "even if a tool named below turns out not to exist.\n" +
      "1. Using the Bash tool with run_in_background set to true, start `node ticker.mjs`. " +
      "Do this first, whatever happens later.\n" +
      "2. Then attempt to call the BashOutput tool on that shell. If there is no such tool, move on.\n" +
      "3. Then attempt to call the KillShell tool on that shell. If there is no such tool, move on.\n" +
      "Finally reply with exactly: done.",
    judge(run) {
      const backgrounded = run
        .usesOf("Bash")
        .some((use) => use.input?.run_in_background === true);
      return {
        completed: run.completed,
        // The precondition: without it the next two fields measure nothing.
        backgrounded,
        bashOutputCalled: run.usedTool("BashOutput"),
        killShellCalled: run.usedTool("KillShell"),
        sawTick: run.toolResults.some((r) => /tick \d+/.test(r.content)),
        errors: run.toolResults.filter((r) => r.isError).map((r) => r.content.slice(0, 120)),
        tools: run.toolNames(),
        initTools: run.init?.tools ?? null,
        prose: run.answer.slice(0, 200),
      };
    },
  },

  /**
   * Whether init.tools can be trusted, answered instead of assumed.
   *
   * The negative verdict the two probes above rest on is "instructed to call
   * it, no tool_use appeared". That reading is only safe if a model asked for a
   * named tool actually reaches for it rather than declining wholesale, so Read
   * runs in the same turn as a positive control: it must produce a tool_use. If
   * Read appears and the candidates do not, absence is absence and not refusal.
   *
   * Glob and Grep are the candidates because features.mjs gates its coverage
   * denominator on a note claiming they work while missing from init.tools.
   * That note predates this probe; whatever comes back here supersedes it.
   */
  "inventory-crosscheck": {
    fixture(dir) {
      write(dir, "src/alpha.mjs", "export const alpha = 1;\n");
      write(dir, "src/beta.mjs", "export const beta = 2;\n");
      write(dir, "notes.txt", "NEEDLE-7Q lives here\n");
      return {};
    },
    prompt:
      "Attempt all three steps in order, with the named tool in each. Never substitute another " +
      "tool, and do not stop early if one of them does not exist -- go on to the next step.\n" +
      "1. Use the Read tool to read notes.txt.\n" +
      "2. Use the Glob tool to list every .mjs file under src/.\n" +
      "3. Use the Grep tool to search for NEEDLE-7Q.\n" +
      "Then reply with one line per step: the tool name and either CALLED or MISSING.",
    judge(run) {
      const initTools = run.init?.tools ?? [];
      const called = (name) => run.usedTool(name);
      const report = (name) => ({ called: called(name), inInit: initTools.includes(name) });
      return {
        completed: run.completed,
        // Positive control. False here invalidates every negative below it.
        controlReadCalled: called("Read"),
        glob: report("Glob"),
        grep: report("Grep"),
        // Do the two independent signals agree for every tool named?
        agrees: ["Read", "Glob", "Grep"].every((n) => called(n) === initTools.includes(n)),
        errors: run.toolResults.filter((r) => r.isError).map((r) => r.content.slice(0, 120)),
        tools: run.toolNames(),
        initTools,
        prose: run.answer.slice(0, 240),
      };
    },
  },
};

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

async function runProbe(name, { model, claudeBin, outDir }) {
  const probe = PROBES[name];
  const slotDir = path.join(outDir, name);
  // An isolated probe gets its workspace outside the repo entirely, so git
  // operations in it cannot resolve to this checkout. Artifacts still land in
  // slotDir; only the workspace moves.
  const workspace = probe.isolate
    ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `probe-${name}-`))
    : path.join(outDir, name, "workspace");
  const configDir = path.join(slotDir, "config");
  const settingsPath = path.join(slotDir, "settings.json");
  fs.mkdirSync(workspace, { recursive: true });

  let bridge = null;
  try {
    bridge = await startBridge({ model, logPath: path.join(slotDir, "bridge.log") });
    await assertModelServed(bridge);
    writeLaunchSettings({ bridge, settingsPath });
    seedConfigDir(configDir, { version: claudeVersion(claudeBin) });

    const fixture = probe.fixture(workspace) ?? {};
    const permission = probe.permissionMode
      ? ["--permission-mode", probe.permissionMode]
      : PERMISSION_ARGS;

    const run = await runHeadless({
      prompt: probe.prompt,
      cwd: workspace,
      settingsPath,
      frontendModel: bridge.frontendModel,
      configDir,
      claudeBin,
      timeoutSeconds: 180,
      transcriptPath: path.join(slotDir, "transcript.jsonl"),
      extraArgs: [...permission, ...(probe.extraArgs?.(fixture) ?? [])],
    });

    return { name, ...probe.judge(run, { workspace, fixture }), workspace, durationMs: run.durationMs };
  } catch (error) {
    return { name, error: `${error.name}: ${error.message}` };
  } finally {
    if (bridge) { try { await bridge.stop(); } catch {} }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let model = "claude-haiku-4.5";
  let only = Object.keys(PROBES);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--only") only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const unknown = only.find((n) => !PROBES[n]);
  if (unknown) throw new Error(`Unknown probe: ${unknown}. Known: ${Object.keys(PROBES).join(", ")}`);

  const claudeBin = resolveClaudeBin();
  const outDir = path.join(ROOT_DIR, ".verify-runs", `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`model:  ${model}`);
  console.log(`claude: ${claudeBin} (${claudeVersion(claudeBin)})`);
  console.log(`host:   ${os.platform()} ${os.arch()} / ${process.version}`);
  console.log(`out:    ${path.relative(ROOT_DIR, outDir)}\n`);

  const results = [];
  for (const name of only) {
    process.stdout.write(`${name.padEnd(20)} ... `);
    const result = await runProbe(name, { model, claudeBin, outDir });
    results.push(result);
    console.log(JSON.stringify(result));
  }

  fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify({ model, results }, null, 2) + "\n", "utf8");
  console.log(`\nwrote ${path.relative(ROOT_DIR, path.join(outDir, "probe.json"))}`);
  return 0;
}

// Guarded so the probe table can be imported by the structural tests. Without
// this, `import { PROBES }` would launch a bridge and a real model run.
if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => { console.error(error); process.exit(1); },
  );
}

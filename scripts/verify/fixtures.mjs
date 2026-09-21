/**
 * Per-slot workspaces.
 *
 * Every slot gets a fresh directory so a model that misbehaves cannot poison
 * another model's evidence. Fixtures plant facts that exist nowhere else --
 * unique tokens, a specific bug, a specific commit subject -- so a driver can
 * tell "the model did the work" apart from "the model guessed well".
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildPdf, buildPng } from "./media.mjs";

const write = (dir, rel, content) => {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
};

const git = (dir, args) =>
  spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Verify Harness",
      GIT_AUTHOR_EMAIL: "verify@example.invalid",
      GIT_COMMITTER_NAME: "Verify Harness",
      GIT_COMMITTER_EMAIL: "verify@example.invalid",
    },
  });

function initGitRepo(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Verify Harness"]);
  git(dir, ["config", "user.email", "verify@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/**
 * `git add -A` in a directory that is not its own repository stages the
 * enclosing one. Fixtures are built inside this checkout, so the one time
 * `git init` was skipped, a fixture seed committed the real repository's
 * working tree under the harness's own author name. The suite's toplevel test
 * catches that after the fact; this refuses to do it in the first place.
 */
function assertOwnToplevel(dir) {
  const result = git(dir, ["rev-parse", "--show-toplevel"]);
  const toplevel = (result.stdout ?? "").trim();
  const sameDir =
    toplevel && fs.realpathSync(toplevel) === fs.realpathSync(dir);
  if (!sameDir) {
    throw new Error(
      `refusing to commit in ${dir}: it is not its own git toplevel ` +
        `(resolved to ${toplevel || "no repository"})`,
    );
  }
}

export function commitAll(dir, message) {
  assertOwnToplevel(dir);
  git(dir, ["add", "-A"]);
  return git(dir, ["commit", "-q", "-m", message]);
}

export function gitLogSubjects(dir) {
  // %s is git's subject, not the message's first line: when the second line
  // is not blank, git folds it up into the subject. A model that writes the
  // requested message and then puts an attribution trailer directly beneath
  // it -- which Claude Code's own guidance asks for -- would fail an exact
  // match against %s for a line it wrote correctly. Read the raw body and
  // take its first line, which is the line the model actually typed.
  const result = git(dir, ["log", "-z", "--format=%B"]);
  return (result.stdout ?? "")
    .split("\0")
    .map((body) => body.split("\n")[0].trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * v01 -- repository reconnaissance
 * ------------------------------------------------------------------ */

function fixtureRepoRecon(dir, { token }) {
  write(dir, "src/index.mjs", `export { createLedger } from "./ledger/create.mjs";\n`);

  // The needle. Nothing else in the tree mentions this constant.
  write(
    dir,
    "src/ledger/settlement.mjs",
    `import { roundHalfEven } from "../util/round.mjs";

/** Basis points applied when a settlement crosses a clearing window. */
export const CLEARING_SPREAD_BPS = 37;

export function settle(entries, { spreadBps = CLEARING_SPREAD_BPS } = {}) {
  const gross = entries.reduce((sum, entry) => sum + entry.amount, 0);
  return roundHalfEven(gross * (1 - spreadBps / 10_000), 2);
}
`,
  );

  // Decoys: plausible homes for the constant that do not define it.
  write(
    dir,
    "src/ledger/clearing.mjs",
    `import { settle } from "./settlement.mjs";

export function clearWindow(window) {
  return settle(window.entries);
}
`,
  );
  write(
    dir,
    "src/util/spread.mjs",
    `export function applySpread(amount, bps) {
  return amount * (1 - bps / 10_000);
}
`,
  );
  write(dir, "src/util/round.mjs", `export function roundHalfEven(value, digits) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floored = Math.floor(scaled);
  const diff = scaled - floored;
  let result = floored;
  if (diff > 0.5) result = floored + 1;
  else if (diff === 0.5) result = floored % 2 === 0 ? floored : floored + 1;
  return result / factor;
}
`);
  write(dir, "docs/ledger.md", `# Ledger\n\nSettlement applies a clearing spread. See the ledger sources.\n`);
  write(dir, "README.md", `# ${token}-ledger\n\nA fixture repository.\n`);

  return {
    needleFile: "src/ledger/settlement.mjs",
    needleSymbol: "CLEARING_SPREAD_BPS",
    needleValue: "37",
    decoys: ["src/ledger/clearing.mjs", "src/util/spread.mjs"],
  };
}

/* ------------------------------------------------------------------ *
 * v02 -- surgical edit
 * ------------------------------------------------------------------ */

function fixtureSurgicalEdit(dir) {
  // Three near-identical lines. Only the middle one may change; the other two
  // catch an over-eager rewrite.
  write(
    dir,
    "config/limits.mjs",
    `export const limits = {
  // retry budget for inbound webhooks
  inboundRetries: 3,
  // retry budget for outbound webhooks
  outboundRetries: 3,
  // retry budget for scheduled jobs
  scheduledRetries: 3,
};
`,
  );
  write(dir, "config/README.md", `# Config\n\nLimits live in limits.mjs.\n`);

  return {
    targetFile: "config/limits.mjs",
    targetKey: "outboundRetries",
    newValue: "7",
    untouched: ["inboundRetries: 3,", "scheduledRetries: 3,"],
    newFile: "config/timeouts.mjs",
    newExport: "timeouts",
    // Plan mode is asked for a DIFFERENT line than the edit turn changes, so
    // the two turns cannot be confused for one another: if the plan turn wrote
    // anything, this line moved, and it is already in `untouched`.
    planTargetKey: "inboundRetries",
    planNewValue: "9",
  };
}

/* ------------------------------------------------------------------ *
 * v03 -- failing test loop
 * ------------------------------------------------------------------ */

function fixtureTestFixLoop(dir) {
  // parseDuration mishandles the "h" unit: hours are multiplied as if minutes.
  write(
    dir,
    "src/duration.mjs",
    `const UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseDuration(input) {
  const match = /^(\\d+)(ms|s|m|h|d)$/.exec(String(input).trim());
  if (!match) throw new TypeError(\`Unparseable duration: \${input}\`);
  return Number(match[1]) * UNITS[match[2]];
}
`,
  );
  write(
    dir,
    "test/duration.test.mjs",
    `import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.mjs";

test("parses milliseconds", () => {
  assert.equal(parseDuration("250ms"), 250);
});

test("parses seconds and minutes", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
});

test("parses hours", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
});

test("parses days", () => {
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("rejects nonsense", () => {
  assert.throws(() => parseDuration("soon"), TypeError);
});
`,
  );
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "duration-fixture", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2) + "\n",
  );

  return {
    sourceFile: "src/duration.mjs",
    testFile: "test/duration.test.mjs",
    testCommand: ["node", "--test", "test/duration.test.mjs"],
    failingCase: "parses hours",
  };
}

/* ------------------------------------------------------------------ *
 * v04 -- background shell and git
 * ------------------------------------------------------------------ */

function fixtureShellOps(dir, { token }) {
  // Named for this slot alone. Slots run concurrently on one machine, and
  // the model is asked to stop this process by name -- `pkill -f ticker.mjs`
  // is a fair reading of that. A shared name makes that command reach into
  // every other slot; a token in the name keeps the blast radius at one
  // workspace.
  const tickerScript = `ticker-${token}.mjs`;
  const logFile = `ticks-${token}.log`;
  write(
    dir,
    tickerScript,
    `import fs from "node:fs";

const target = process.argv[2] ?? "${logFile}";
let n = 0;
const timer = setInterval(() => {
  n += 1;
  fs.appendFileSync(target, \`tick \${n}\\n\`);
  if (n >= 25) {
    clearInterval(timer);
    process.exit(0);
  }
}, 700);
`,
  );
  write(dir, "NOTES.md", `# Notes\n\nNothing yet.\n`);
  commitAll(dir, "chore: seed fixture");

  return {
    tickerScript,
    logFile,
    minTicks: 3,
    commitSubject: `chore: record ${token} ticks`,
    recordFile: "TICKS.md",
    // A worktree is a sibling of the workspace, so it lands inside the slot's
    // own temp root and is removed with it. The branch carries the slot token:
    // worktree branch names are global to the repository they belong to, and a
    // shared name would collide between concurrent slots.
    worktreeDir: "../review",
    worktreeBranch: `review/${token}`,
    worktreeFile: "REVIEW.md",
    worktreeMarker: `REVIEWED-${token}`,
  };
}

/* ------------------------------------------------------------------ *
 * v05 -- tracked multi-step execution
 * ------------------------------------------------------------------ */

function fixtureMultiStep(dir, { token }) {
  write(
    dir,
    "src/greet.mjs",
    `export function greet(name) {
  return "Hello, " + name + "!";
}
`,
  );
  write(dir, "src/farewell.mjs", `export function farewell(name) {
  return "Bye, " + name + ".";
}
`);
  write(dir, "VERSION", "0.1.0\n");

  // A real notebook, so NotebookEdit has something valid to operate on and a
  // malformed result is detectable by parsing it back.
  write(
    dir,
    "analysis.ipynb",
    JSON.stringify(
      {
        cells: [
          {
            cell_type: "markdown",
            id: "intro",
            metadata: {},
            source: ["# Rate analysis\n"],
          },
          {
            cell_type: "code",
            execution_count: null,
            id: "rates",
            metadata: {},
            outputs: [],
            source: ["RATE = 0.05\n", "print(RATE)\n"],
          },
        ],
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python", version: "3.11.0" },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ) + "\n",
  );

  // Two binary attachments, each carrying a token drawn right here.
  //
  // They deliberately do NOT reuse `token`: step 3 prints that one in the
  // prompt, so a model could answer "PDFDOC-<token>" from the prompt alone and
  // score the attachment checks without opening either file. One did.
  //
  // Hex keeps every character inside the fixture font's alphabet, and a byte
  // count fixes the width: a base-36 slice of Math.random() is not guaranteed
  // to be six characters, and a short draw would leave a needle that matches
  // almost any answer. The entropy here is the whole check. No separator
  // appears in either token, because the image is read by segmenting glyphs:
  // two models made the same mis-read of the rasterised prefix and only the
  // separator they happened to type ("IMG TAG" vs "IMG-TAG") decided which of
  // them passed. With no separator in the needle, that coin flip is gone.
  const mediaToken = () => randomBytes(3).toString("hex").toUpperCase();
  const pdfToken = `PDFDOC${mediaToken()}`;
  const pngToken = `IMGTAG${mediaToken()}`;
  fs.writeFileSync(path.join(dir, "invoice.pdf"), buildPdf(pdfToken));
  fs.writeFileSync(path.join(dir, "banner.png"), buildPng(pngToken));

  return {
    steps: [
      { file: "src/greet.mjs", expect: "Good morning" },
      { file: "VERSION", expect: "0.2.0" },
      { file: "CHANGELOG.md", expect: token },
      { file: "analysis.ipynb", expect: "0.08" },
    ],
    notebookFile: "analysis.ipynb",
    newRate: "0.08",
    pdfFile: "invoice.pdf",
    pngFile: "banner.png",
    pdfToken,
    pngToken,
    token,
  };
}

/* ------------------------------------------------------------------ *
 * v06 -- subagent delegation
 * ------------------------------------------------------------------ */

function fixtureSubagent(dir, { token }) {
  write(
    dir,
    ".claude/agents/scout.md",
    `---
name: scout
description: Searches the repository for deprecation markers and reports the file paths that carry them.
tools: Read, Bash
---

You are a code scout. You are given a marker string.

Search every file under the current directory for that exact marker. Report
the relative path of each file that contains it, one per line, sorted
alphabetically. Report nothing else -- no preamble, no summary, no advice.
`,
  );

  // Three carriers among ten files; the marker appears nowhere else.
  const marker = `DEPRECATED-${token}`;
  write(dir, "src/alpha.mjs", `export const alpha = 1;\n`);
  write(dir, "src/beta.mjs", `// ${marker}: replaced by gamma\nexport const beta = 2;\n`);
  write(dir, "src/gamma.mjs", `export const gamma = 3;\n`);
  write(dir, "src/delta.mjs", `// ${marker}: fold into epsilon\nexport const delta = 4;\n`);
  write(dir, "src/epsilon.mjs", `export const epsilon = 5;\n`);
  write(dir, "lib/zeta.mjs", `export const zeta = 6;\n`);
  write(dir, "lib/eta.mjs", `// ${marker}: unused since 2024\nexport const eta = 7;\n`);
  write(dir, "lib/theta.mjs", `export const theta = 8;\n`);
  write(dir, "docs/notes.md", `Notes about the modules.\n`);
  write(dir, "README.md", `# scout fixture\n`);

  return {
    marker,
    agentName: "scout",
    carriers: ["lib/eta.mjs", "src/beta.mjs", "src/delta.mjs"],
  };
}

/* ------------------------------------------------------------------ *
 * v07 -- MCP browser automation
 * ------------------------------------------------------------------ */

function fixtureMcpPlaywright(dir, { token }) {
  const pageToken = `PLW-${token}`;
  write(
    dir,
    "public/index.html",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Release status</title>
  </head>
  <body>
    <h1>Release status</h1>
    <p>Pipeline: nightly</p>
    <p>Build token: <span id="build-token">${pageToken}</span></p>
    <p>Owner: platform</p>
  </body>
</html>
`,
  );
  return { pageToken, pageFile: "public/index.html", elementId: "build-token" };
}

/* ------------------------------------------------------------------ *
 * v08 -- hooks, memory, commands, skills
 * ------------------------------------------------------------------ */

function fixtureHooksMemory(dir, { token }) {
  const recordPath = "records/audit.md";
  const hookLog = ".claude/hook.log";

  // Observer hook: proves PreToolUse fires at all.
  write(
    dir,
    ".claude/hooks/log-tool.sh",
    `#!/usr/bin/env bash
# Records that PreToolUse ran. Exit 0 = allow.
printf '%s\\n' "pre-tool-use fired" >> "\${CLAUDE_PROJECT_DIR:-.}/.claude/hook.log"
exit 0
`,
  );
  // Deny hook: exit 2 blocks the call and feeds stderr back to the model.
  write(
    dir,
    ".claude/hooks/deny-curl.sh",
    `#!/usr/bin/env bash
payload=$(cat)
if printf '%s' "$payload" | grep -q 'curl'; then
  printf '%s\\n' "deny fired" >> "\${CLAUDE_PROJECT_DIR:-.}/.claude/hook.log"
  printf '%s\\n' "Network access with curl is forbidden in this project. Do not retry; report that it is blocked." >&2
  exit 2
fi
exit 0
`,
  );
  fs.chmodSync(path.join(dir, ".claude/hooks/log-tool.sh"), 0o755);
  fs.chmodSync(path.join(dir, ".claude/hooks/deny-curl.sh"), 0o755);

  write(
    dir,
    ".claude/settings.json",
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/log-tool.sh" }] },
            { matcher: "Bash", hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/deny-curl.sh" }] },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );

  // Project memory: a rule with an arbitrary destination the model can only
  // know by reading CLAUDE.md.
  write(
    dir,
    "CLAUDE.md",
    `# Project rules

- Every audit record MUST be written to \`${recordPath}\`. Never write audit
  records anywhere else, whatever path the request suggests.
- Audit records are Markdown and always begin with the heading \`# Audit\`.
`,
  );

  write(
    dir,
    ".claude/commands/audit-status.md",
    `---
description: Report the audit record location mandated by this project
---

State the exact path this project mandates for audit records, and nothing else.
`,
  );

  write(
    dir,
    ".claude/skills/audit-format/SKILL.md",
    `---
name: audit-format
description: House format for audit records in this project. Use when writing or reviewing an audit record.
---

# Audit record format

An audit record is Markdown:

1. A \`# Audit\` heading.
2. A \`Token:\` line carrying the audit token verbatim.
3. A \`Status:\` line that reads \`recorded\`.
`,
  );

  write(dir, "src/app.mjs", `export const app = "fixture";\n`);

  // A plugin: the same kinds of surface the project already supplies, but
  // arriving from --plugin-dir instead of from .claude/. Whether the bridge
  // carries it is a separate question from whether it carries project files,
  // because the init event advertises them through different keys.
  const pluginDir = path.join(dir, "audit-plugin");
  write(
    pluginDir,
    ".claude-plugin/plugin.json",
    JSON.stringify(
      { name: "audit-plugin", version: "0.1.0", description: "Audit helpers supplied as a plugin" },
      null,
      2,
    ) + "\n",
  );
  write(
    pluginDir,
    "commands/audit-plugin-info.md",
    "---\ndescription: Report which plugin supplies the audit helpers\n---\n\nReply with exactly: audit-plugin\n",
  );
  write(
    pluginDir,
    "skills/audit-retention/SKILL.md",
    "---\nname: audit-retention\ndescription: Retention rules for audit records. Use when asked how long audit records are kept.\n---\n\n# Audit retention\n\nAudit records are retained for 90 days.\n",
  );

  return {
    recordPath,
    hookLog,
    auditToken: `AUD-${token}`,
    forbiddenCommand: "curl",
    commandName: "audit-status",
    skillName: "audit-format",
    pluginDir,
    pluginCommandName: "audit-plugin-info",
    pluginSkillName: "audit-retention",
    // Pinned to a minute and a month, so it is unambiguously a one-shot the
    // scheduler will not fire during the slot.
    cronExpression: "37 4 1 1 *",
    cronPrompt: `audit sweep ${token}`,
  };
}

/* ------------------------------------------------------------------ *
 * v09 -- session resume
 * ------------------------------------------------------------------ */

function fixtureSessionResume(dir, { token }) {
  const buildId = `BUILD-${token}`;
  write(dir, "README.md", `# resume fixture\n\nNothing here names the build id.\n`);
  return { buildId, deployWindow: "Thursday 02:00 UTC" };
}

/* ------------------------------------------------------------------ *
 * v10 -- long context
 * ------------------------------------------------------------------ */

function fixtureLongContext(dir, { token }) {
  // Two facts, deliberately far apart, in a corpus large enough that a
  // truncating transport would drop one of them.
  const early = 4_270;
  const late = 1_180;
  const lines = [];
  lines.push(`# Regional ledger export ${token}`);
  lines.push("");
  lines.push("## Section 1 -- Northern region");
  lines.push("");
  lines.push(`The northern region settled **${early}** transactions in the reporting window.`);
  lines.push("");

  const filler = (section, index) =>
    `Entry ${section}.${index}: routing lane ${((index * 37) % 97) + 1} handled batch ` +
    `${(index * 13) % 89} with checksum ${((index * 7919) % 65_536).toString(16)} and ` +
    `no exceptions recorded for the settlement pass.`;

  for (let section = 2; section <= 24; section += 1) {
    lines.push(`## Section ${section} -- Operational detail`);
    lines.push("");
    for (let index = 1; index <= 40; index += 1) lines.push(filler(section, index));
    lines.push("");
  }

  lines.push("## Section 25 -- Southern region");
  lines.push("");
  lines.push(`The southern region settled **${late}** transactions in the reporting window.`);
  lines.push("");
  lines.push("## Section 26 -- Closing notes");
  lines.push("");
  lines.push("No further adjustments were applied after the closing pass.");

  const body = lines.join("\n") + "\n";
  write(dir, "export/ledger-export.md", body);

  return {
    corpusFile: "export/ledger-export.md",
    northern: early,
    southern: late,
    expectedDifference: early - late,
    approxWords: body.split(/\s+/).length,
  };
}

/* ------------------------------------------------------------------ *
 * v11 -- launcher, daemon and background agent
 * ------------------------------------------------------------------ */

function fixtureDaemonBackground(dir, { token }) {
  // The background agent is detached: nothing of its stream reaches the
  // harness. So the only evidence it did real work is a file it could not have
  // written without reading another file first. The channel name is never in
  // the prompt -- it exists only here.
  const channel = `${token}-canary`;
  write(
    dir,
    "src/release.mjs",
    `/** Release channel this build publishes to. */
export const DEPLOY_CHANNEL = "${channel}";

export function isCanary() {
  return DEPLOY_CHANNEL.endsWith("-canary");
}
`,
  );
  // A second fact for the foreground turn, so the daemon-reuse step also has
  // to read something rather than answer from the prompt.
  write(
    dir,
    "src/build.mjs",
    `/** Build number stamped at release time. */
export const BUILD_NUMBER = 8123;
`,
  );
  write(dir, "README.md", `# ${token}-service\n\nA fixture repository.\n`);

  // Two obstacles that have nothing to do with what this scenario measures,
  // both found by running it.
  //
  // A background session refuses to edit a shared checkout: it demands
  // EnterWorktree first, so its changes land in a linked worktree. That guard
  // is real and v04 already covers worktrees; here it would only move the
  // agent's output somewhere the driver is not looking. The guard's own error
  // message names the way to turn it off, so the fixture takes it.
  write(
    dir,
    ".claude/settings.json",
    `${JSON.stringify({ worktree: { bgIsolation: "none" } }, null, 2)}\n`,
  );
  // And EnterWorktree could not have succeeded anyway: every fixture repo is
  // `git init`-ed but not committed, so HEAD does not resolve and the agent
  // burned its budget retrying. A checkout with no commits is not a realistic
  // starting point regardless.
  commitAll(dir, "chore: seed fixture");

  return {
    channelFile: "src/release.mjs",
    channelValue: channel,
    backgroundResult: "CHANNEL.txt",
    buildFile: "src/build.mjs",
    buildNumber: "8123",
  };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

const BUILDERS = {
  "v01-repo-recon": fixtureRepoRecon,
  "v02-surgical-edit": fixtureSurgicalEdit,
  "v03-test-fix-loop": fixtureTestFixLoop,
  "v04-shell-ops": fixtureShellOps,
  "v05-multi-step": fixtureMultiStep,
  "v06-subagent": fixtureSubagent,
  "v07-mcp-playwright": fixtureMcpPlaywright,
  "v08-hooks-memory": fixtureHooksMemory,
  "v09-session-resume": fixtureSessionResume,
  "v10-long-context": fixtureLongContext,
  "v11-daemon-background": fixtureDaemonBackground,
};

export const FIXTURE_IDS = Object.freeze(Object.keys(BUILDERS));

export function buildFixture(scenarioId, workspaceDir, { token } = {}) {
  const builder = BUILDERS[scenarioId];
  if (!builder) throw new Error(`No fixture for scenario ${scenarioId}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Every workspace is its own repository, established before the builder
  // writes a single file.
  //
  // Slots live under .verify-runs/ inside this checkout. A workspace with no
  // .git of its own resolves `git rev-parse --show-toplevel` to the real
  // repository, and a model that anchors a mandated path to the toplevel then
  // writes into the source tree instead of the sandbox. One slot did exactly
  // that: it honoured CLAUDE.md to the letter, wrote records/audit.md at the
  // toplevel it was given, and failed three checks for work it had actually
  // done. The boundary is the fix; the driver was right to look only in the
  // workspace.
  initGitRepo(workspaceDir);
  const shortToken = token ?? Math.random().toString(36).slice(2, 8).toUpperCase();
  const meta = builder(workspaceDir, { token: shortToken }) ?? {};
  return { dir: workspaceDir, token: shortToken, ...meta };
}

export function readIfPresent(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

export function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

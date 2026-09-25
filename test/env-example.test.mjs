import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// README calls .env.example the list of every variable, and a variable nobody
// documents still reaches the persistent bridge, which inherits the launching
// shell's environment. So each one the code reads is either an entry or named
// under "Left out on purpose", and nothing is named there that nothing reads.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = readFileSync(path.join(rootDir, ".env.example"), "utf8");

function filesIn(directory, { recursive = false, match = () => true } = {}) {
  return readdirSync(path.join(rootDir, directory)).flatMap((name) => {
    const relative = path.join(directory, name);
    if (statSync(path.join(rootDir, relative)).isDirectory()) {
      return recursive ? filesIn(relative, { recursive, match }) : [];
    }
    return match(name) ? [relative] : [];
  });
}

const PATTERNS = {
  // process.env.NAME, env.NAME, env["NAME"], and server.mjs's integer reader.
  js: [
    /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:process\.env|env)\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    /\breadPositiveIntegerEnv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  ],
  // ${NAME:-x}, ${NAME-x}, ${NAME+x}, ${NAME:+x}: how the launchers take an
  // optional variable from the caller. Their own variables are plain $NAME.
  shell: [/\$\{([A-Z][A-Z0-9_]*)(?::?[-+=?])/g],
};

function namesRead(files, patterns) {
  const names = new Map();
  for (const file of files) {
    const source = readFileSync(path.join(rootDir, file), "utf8");
    for (const pattern of patterns) {
      for (const [, name] of source.matchAll(pattern)) {
        if (!names.has(name)) names.set(name, file);
      }
    }
  }
  return names;
}

const launchers = filesIn("bin", { match: (name) => !name.startsWith(".") });
const shellScripts = [...launchers, ...filesIn("scripts", { match: (name) => name.endsWith(".sh") })];
const modules = filesIn("src", { match: (name) => name.endsWith(".mjs") });

// Exempt: Claude Code's own ANTHROPIC_* names. provider-detection.mjs reads them
// from a settings file's env block, not from the environment, and .env.example
// covers them as a group ("Claude Code's own ANTHROPIC_* variables").
const EXEMPT_PREFIXES = ["ANTHROPIC_"];

test(".env.example names every variable src/ and bin/ read", () => {
  const read = new Map([
    ...namesRead([...modules, ...launchers], PATTERNS.js),
    ...namesRead(shellScripts, PATTERNS.shell),
  ]);
  assert.ok(read.has("GHCP_DAEMON_DIR") && read.has("MAX_BODY_BYTES") && read.has("LITELLM_API_KEY"),
    "the scan no longer finds variables it is known to read");
  const missing = [...read]
    .filter(([name]) => !EXEMPT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter(([name]) => !new RegExp(`\\b${name}\\b`).test(example))
    .map(([name, file]) => `${name} (read in ${file})`);
  assert.deepEqual(missing, []);
});

function leftOutNames() {
  const block = example.split("# Left out on purpose:\n")[1]?.split("\n\n")[0];
  assert.ok(block, "the 'Left out on purpose' block is missing");
  return block
    .split("\n# - ")
    .map((entry) => entry.replace(/^# - /, "").split(":")[0])
    // NAME_* is a family, not a variable.
    .flatMap((label) => label.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b(?!\*)/g) ?? []);
}

// The Copilot SDK reads this one itself; the entry tells users to leave it
// unset. Checked against the SDK so the exemption lapses if the SDK drops it.
const READ_BY_SDK = {
  COPILOT_SDK_DEFAULT_CONNECTION: "node_modules/@github/copilot-sdk/dist/client.js",
};

test("everything .env.example leaves out on purpose is still read somewhere", () => {
  const names = leftOutNames();
  assert.ok(names.includes("BRIDGE_VERIFY_OBSERVE"), names.join(", "));
  const sources = [
    ...modules,
    ...launchers,
    ...filesIn("scripts", { recursive: true, match: (name) => /\.(?:mjs|sh|py)$/.test(name) }),
  ];
  const read = new Set([
    ...namesRead(sources, [...PATTERNS.js, ...PATTERNS.shell, /\$([A-Z][A-Z0-9_]*)/g]).keys(),
  ]);
  const stale = names.filter((name) => {
    if (READ_BY_SDK[name]) {
      return !readFileSync(path.join(rootDir, READ_BY_SDK[name]), "utf8").includes(`"${name}"`);
    }
    return !read.has(name);
  });
  assert.deepEqual(stale, []);
});

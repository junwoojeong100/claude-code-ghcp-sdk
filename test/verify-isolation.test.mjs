/** Private native history is allowed, external memory and plugin installs are not. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { configEvidence } from "../scripts/verify/drivers.mjs";
import { BridgeStartupError, ROOT_DIR, UNRECORDED_BRIDGE_KNOBS, cleanVerificationEnv, startBridge, writeLaunchSettings } from "../scripts/verify/bridge.mjs";
import { runtimeTimeouts } from "../scripts/verify/timeouts.mjs";

function setup(t) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-isolation-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const ctx = { configDir, workspace: "/private/workspace" }, value = "VERIFY_private_nonce";
  const inputs = [`Remember ${value}`, "/exit"], sessions = new Set(["owned-session"]);
  const row = { display: inputs[0], pastedContents: {}, timestamp: 1, project: ctx.workspace, sessionId: "owned-session" };
  const write = (name, content) => {
    const file = path.join(configDir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { ctx, value, row, write, check: () => configEvidence(ctx, [value], sessions, inputs) };
}

test("owned native input history and transcript do not count as auxiliary memory", t => {
  const f = setup(t);
  f.write("history.jsonl", JSON.stringify(f.row) + "\n");
  f.write("projects/workspace/owned-session.jsonl", JSON.stringify({ message: f.value }));
  f.write("home/Applications/CLI/Contents/Info.plist", "normal registration metadata");
  assert.equal(f.check().ok, true, f.check().reason);
});

for (const [name, change] of [
  ["foreign session", row => { row.sessionId = "foreign"; }],
  ["foreign workspace", row => { row.project = "/other/workspace"; }],
  ["unsubmitted input", row => { row.display = "not submitted"; }],
  ["hidden field", row => { row.memory = "side channel"; }],
  ["pasted content", row => { row.pastedContents = { 1: "side channel" }; }],
]) test(`native history rejects ${name}`, t => {
  const f = setup(t); change(f.row);
  f.write("history.jsonl", JSON.stringify(f.row) + "\n");
  assert.equal(f.check().ok, false); assert.match(f.check().reason, /history\.jsonl/);
});

test("malformed native history is rejected", t => {
  const f = setup(t); f.write("history.jsonl", "{unfinished");
  assert.equal(f.check().ok, false);
});

for (const file of ["notes.txt", "projects/workspace/foreign-session.jsonl", "memory/value.txt",
  "plugins/marketplaces/external/README.md", "plugins/cache/external/plugin.json"]) {
  test(`private config rejects ${file}`, t => {
    const f = setup(t); f.write(file, file.startsWith("plugins/") ? "external plugin" : f.value);
    assert.equal(f.check().ok, false); assert.ok(f.check().reason.includes(file));
  });
}

test("private config never follows a symlink", t => {
  const f = setup(t); fs.symlinkSync("/missing/target", path.join(f.ctx.configDir, "linked"));
  assert.equal(f.check().ok, false); assert.match(f.check().reason, /linked/);
});

for (const target of ["/pinned/claude", "/other/claude", "../../other/claude"]) {
  test(`URL-handler registration requires the exact pinned CLI target: ${target}`, t => {
    const f = setup(t); f.ctx.claudeBin = "/pinned/claude";
    const file = path.join(f.ctx.configDir, "home/Applications/Claude Code URL Handler.app/Contents/MacOS/claude");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file);
    assert.equal(f.check().ok, target === f.ctx.claudeBin, f.check().reason);
  });
}

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-bridge-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const bridge = { model: "claude-sonnet-5", baseUrl: "http://127.0.0.1:4999", token: "verify-owned-token", frontendModel: "claude-sonnet-5" };

test("launch settings receive the bridge token only through the environment", t => {
  const root = tempDir(t), settingsPath = path.join(root, "out", "settings.json");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "write-launch-settings.mjs"), `import fs from "node:fs";
fs.writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(2), token: process.env.GHCP_BRIDGE_TOKEN,
  ghcp: Object.keys(process.env).filter(k => k.startsWith("GHCP_")) }));`);
  writeLaunchSettings({ bridge, settingsPath, rootDir: root,
    env: { PATH: process.env.PATH, GHCP_BRIDGE_TOKEN: "parent-token", GHCP_NATIVE_TOOL_SEARCH: "1" } });
  const seen = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(seen.argv, [settingsPath, bridge.baseUrl, bridge.frontendModel]);
  assert.ok(!seen.argv.some(a => a.includes(bridge.token)));
  assert.equal(seen.token, bridge.token);
  assert.deepEqual(seen.ghcp, ["GHCP_BRIDGE_TOKEN"]);
});

test("the production writer accepts the verifier's launch settings call", t => {
  const settingsPath = path.join(tempDir(t), "settings.json");
  writeLaunchSettings({ bridge, settingsPath, env: { PATH: process.env.PATH } });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).env.ANTHROPIC_AUTH_TOKEN, bridge.token);
});

test("verification children drop unrecorded bridge knobs but keep credentials and recorded budgets", () => {
  const kept = { PATH: "/bin", HOME: "/fixture", GH_TOKEN: "gh", COPILOT_GITHUB_TOKEN: "copilot", COPILOT_HOME: "/fixture/.copilot",
    COPILOT_CLI_PATH: "/fixture/copilot", HTTPS_PROXY: "http://proxy", TURN_IDLE_TIMEOUT_MS: "1000", PENDING_TOOL_WAIT_MS: "2000" };
  const env = { ...kept, ...Object.fromEntries(UNRECORDED_BRIDGE_KNOBS.map(k => [k, "1"])) };
  assert.deepEqual(cleanVerificationEnv(env), kept);
});

// The SDK reads this on its default connection, which the bridge uses (no connection option).
const SDK_ENV = ["COPILOT_SDK_DEFAULT_CONNECTION"];
const CREDENTIAL_ENV = new Set(["COPILOT_HOME"]);
test("every environment knob the bridge reads is set by the verifier, recorded, a credential location, or stripped", async t => {
  const source = fs.readFileSync(path.join(ROOT_DIR, "src", "server.mjs"), "utf8");
  const names = new Set([...source.matchAll(/readPositiveIntegerEnv\(\s*"([A-Z0-9_]+)"/g), ...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]).concat(SDK_ENV));
  assert.ok(names.has("MAX_REPLAY_BYTES") && names.has("TURN_IDLE_TIMEOUT_MS") && names.size > 20, [...names].join());
  const recorded = new Set();
  runtimeTimeouts(new Proxy({}, { get: (_, key) => { recorded.add(key); return undefined; } }));
  const root = tempDir(t), sentinel = name => `parent-${name}`;
  let childEnv;
  const spawnProcess = (cmd, args, options) => { childEnv = options.env; return Object.assign(new EventEmitter(), { unref() {} }); };
  await assert.rejects(startBridge({ model: "claude-sonnet-5", logPath: path.join(root, "bridge.log"), healthTimeoutMs: 1, cleanupTimeoutMs: 100,
    env: Object.fromEntries([...names].map(n => [n, sentinel(n)])), spawnProcess }), BridgeStartupError);
  const unrecorded = [];
  for (const name of names) {
    const value = childEnv[name];
    if (recorded.has(name) || CREDENTIAL_ENV.has(name)) assert.equal(value, sentinel(name), `${name} must reach the bridge unchanged`);
    else if (value !== undefined && value !== sentinel(name)) continue; // set by the verifier for every bridge
    else if (value !== undefined) unrecorded.push(name);
  }
  assert.deepEqual(unrecorded, [], "unrecorded bridge knobs inherited from the operator");
  for (const name of [...UNRECORDED_BRIDGE_KNOBS, "BRIDGE_TEST_FAULTS", "BRIDGE_LEASE_DIR"]) assert.equal(childEnv[name], undefined, name);
  assert.equal(childEnv.HOST, "127.0.0.1"); assert.equal(childEnv.BRIDGE_VERIFY_OBSERVE, "1");
});

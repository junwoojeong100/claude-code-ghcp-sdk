/** Transport contracts without an installed CLI or provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveSession, normalizeNativeEvent, orderNativeEvents, parsePicker, privateCLIEnv } from "../scripts/verify/interactive.mjs";
import { runHeadless } from "../scripts/verify/session.mjs";
import { readRecording } from "../scripts/verify/recording.mjs";
import { PRIMARY_MODELS } from "../scripts/verify/scenarios.mjs";

function fakeCLI(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-transport-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeBin = path.join(root, "cli.mjs");
  fs.writeFileSync(claudeBin, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { claudeBin, cwd: root, configDir: root, settingsPath: path.join(root, "settings.json"), frontendModel: "fixture", prompt: "fixture", timeoutSeconds: 3 };
}

test("native records follow parent UUIDs rather than append order", () => {
  const child = { uuid: "assistant", parentUuid: "attachment", type: "assistant" };
  const user = { uuid: "user", parentUuid: null, type: "user" };
  const attachment = { uuid: "attachment", parentUuid: "user", type: "attachment" };
  assert.deepEqual(orderNativeEvents([child, user, attachment]), [user, attachment, child]);
  assert.throws(() => orderNativeEvents([{ uuid: "a", parentUuid: "b" }, { uuid: "b", parentUuid: "a" }]), /Cycle/);
  assert.equal(normalizeNativeEvent({ sessionId: "native", isSidechain: true }).parent_tool_use_id, "native-sidechain");
});

test("picker requires a checked row and never substitutes the highlighted row", () => {
  const rows = PRIMARY_MODELS.map((id, i) => ` ${i === 2 ? "❯ " : ""}${i + 1}. Model (${id})${i === 1 ? " ✔" : ""}`);
  const screen = "Select model\n" + rows.join("\n");
  assert.deepEqual(parsePicker(screen).models, PRIMARY_MODELS);
  assert.equal(parsePicker(screen).current, PRIMARY_MODELS[1]);
  assert.equal(parsePicker(screen.replace(" ✔", "")).current, null);
  assert.equal(parsePicker("No picker").current, null);
});

test("private CLI environment excludes credentials and injection overrides", () => {
  const env = privateCLIEnv({ home: "/private/home", configDir: "/private/config", tmpDir: "/private/tmp",
    env: { PATH: "/safe/bin", GH_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", NODE_OPTIONS: "injected", CLAUDE_CONFIG_DIR: "/global" } });
  assert.equal(env.HOME, "/private/home"); assert.equal(env.CLAUDE_CONFIG_DIR, "/private/config");
  for (const name of ["GH_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) assert.equal(env[name], undefined);
  assert.equal(env.DISABLE_TELEMETRY, "1"); assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, "1");
});

test("print cleanup records a normal reaped exit", async t => {
  const options = fakeCLI(t, `process.stdin.resume(); process.stdin.on('end', () => {\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));\n});`);
  const run = await runHeadless(options);
  assert.equal(run.completed, true, run.failureHint);
  assert.equal(run.cleanup.ok, true); assert.equal(run.cleanup.groupGone, true);
  assert.equal(run.cleanup.exitCode, 0); assert.equal(run.cleanup.forced, false);
});

test("print abort is bounded and cannot be counted as success", async t => {
  const options = fakeCLI(t, "process.stdin.resume(); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150); t.after(() => clearTimeout(timer));
  const run = await runHeadless({ ...options, signal: controller.signal });
  assert.equal(run.completed, false); assert.match(run.ioError, /aborted/);
  assert.equal(run.cleanup.groupGone, true); assert.equal(run.cleanup.forced, true);
});

test("invalid native command is rejected without creating a process", async () => {
  const session = new InteractiveSession({ timeoutMs: 1000 });
  await assert.rejects(session.command("/login"), /Unsupported/);
  assert.equal(session.pid, null); await session.close(); session.terminal.dispose();
});

// A prompt-only fake CLI under the real PTY helper: no provider, no dialogs.
const PROMPT_CLI = [
  "process.stdout.write('size ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n\\u276f\\r\\n');",
  "process.stdin.on('data', data => { if (String(data).includes('/exit')) { process.stdout.write('bye\\r\\n'); process.exit(0); } });",
].join("\n");
function nativeSession(t) {
  // Keep os.tmpdir() unresolved: macOS /var is a symlinked ancestor of the slot.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-native-recording-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeBin = path.join(root, "cli.mjs"), settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(claudeBin, `#!${process.execPath}\n${PROMPT_CLI}\n`, { mode: 0o700 });
  fs.writeFileSync(settingsPath, "{}\n");
  return new InteractiveSession({ claudeBin, settingsPath, frontendModel: "fixture", timeoutMs: 20000,
    workspace: path.join(root, "workspace"), configDir: path.join(root, "config"), slotDir: path.join(root, "slot") });
}
const recorded = frames => Buffer.concat(frames.filter(f => f.type === "output").map(f => Buffer.from(f.data, "base64")));

test("a native launch records exactly its raw terminal output bytes, with phase markers", { timeout: 30000 }, async t => {
  const session = nativeSession(t);
  session.markPhase("print"); // No recording before launch: a silent no-op.
  await session.start();
  session.markPhase("seed"); session.markPhase("not a label"); session.markPhase(7);
  const file = session.result([]).terminalOutputPath;
  assert.equal(file, path.join(fs.realpathSync(session.options.slotDir), `terminal-output-${session.launchId}.jsonl`));
  const receipt = await session.close();
  assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.forced, false);
  assert.equal(session.recording.status().state, "complete");
  const { header, frames, footer } = readRecording(file), raw = fs.readFileSync(session.rawPath);
  assert.deepEqual([header.launch, header.session, header.cols, header.rows], [session.launchId, session.sessionId, 160, 48]);
  assert.deepEqual(recorded(frames), raw);
  assert.match(raw.toString(), /size 160x48[\s\S]*bye/);
  assert.deepEqual(frames.filter(f => f.type === "phase").map(f => f.label), ["seed"]);
  const phase = frames.findIndex(f => f.type === "phase");
  assert.ok(phase > 0 && phase < frames.length - 1, "the phase separates startup output from /exit output");
  assert.equal(footer.complete, true); assert.equal(footer.outputBytes, raw.length);
});

test("a recording capture error never breaks the native session or its raw log", { timeout: 30000 }, async t => {
  const session = nativeSession(t);
  fs.mkdirSync(session.options.slotDir, { recursive: true });
  const blocked = path.join(session.options.slotDir, `terminal-output-${session.launchId}.jsonl`);
  fs.writeFileSync(blocked, "not a recording\n");
  await session.start();
  session.markPhase("seed");
  assert.equal(session.recording.status().state, "error");
  const receipt = await session.close();
  assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.forced, false);
  assert.equal(fs.readFileSync(blocked, "utf8"), "not a recording\n");
  assert.match(fs.readFileSync(session.rawPath, "utf8"), /size 160x48[\s\S]*bye/);
});

test("a PTY size other than the recording header's 160x48 is launched but not recorded", { timeout: 30000 }, async t => {
  const session = nativeSession(t);
  session.terminal.resize(140, 42);
  await session.start();
  session.markPhase("seed");
  assert.equal(session.recording, undefined); assert.equal(session.result([]).terminalOutputPath, null);
  assert.equal((await session.close()).ok, true);
  assert.match(fs.readFileSync(session.rawPath, "utf8"), /size 140x42/);
  assert.deepEqual(fs.readdirSync(session.options.slotDir).filter(name => name.startsWith("terminal-output-")), []);
});

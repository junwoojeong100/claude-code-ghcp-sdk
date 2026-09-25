/** Native observer/PTY contract tests with synthetic output, never a provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveSession } from "../scripts/verify/interactive.mjs";

const marker = "⎿ Interrupted · What should Claude do instead?";
const user = text => ({ uuid: text, parentUuid: text === "synthetic" ? null : "synthetic", type: "user", message: { content: text } });
async function setup(t, initial = "❯") {
  const session = new InteractiveSession({ timeoutMs: 2000 });
  session.startedAt = Date.now();
  t.after(() => session.terminal.dispose());
  const render = text => session.receiveOutput(Buffer.from("\x1b[2J\x1b[H" + text.replaceAll("\n", "\r\n")), session.outputSequence + 1);
  await render(initial);
  const events = [], writes = [];
  session.snapshot = () => new Set(events.map(e => e.uuid));
  session.freshEvents = before => events.filter(e => !before.has(e.uuid));
  session.child = { stdin: { destroyed: false, write(line) {
    const message = JSON.parse(line); writes.push(Buffer.from(message.data, "base64").toString());
    session.acknowledgeInput({ sequence: message.sequence, accepted: true, byteCount: Buffer.from(message.data, "base64").length,
      outputSequence: session.outputSequence, elapsedMs: session.elapsedMs() });
    return true;
  } } };
  session.enter = async prompt => {
    const receipt = { renderSequence: session.renderSequence, writeOutputSequence: session.outputSequence };
    events.push(user(prompt));
    await render(`❯ ${prompt}\n✻ Working…\n${initial.includes(marker) ? marker + "\n" : ""}esc to interrupt\n❯`);
    return receipt;
  };
  return { session, render, events, writes };
}

for (const kind of ["event", "tool-event", "render"]) test(`fresh ${kind} interruption requires acknowledged Escape and idle render`, async t => {
  const { session, render, events, writes } = await setup(t);
  const pending = session.submit("synthetic", { timeoutMs: 1000 });
  await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
  const receipt = await session.escape({ purpose: "test-interrupt" });
  if (kind !== "render") events.push(user(kind === "event" ? "[Request interrupted by user]" : "[Request interrupted by user for tool use]"));
  await render(kind === "render" ? marker + "\n❯" : "❯");
  const result = await pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.interruption.nativeReceipt.kind, kind === "render" ? "render" : "event");
  assert.equal(result.interruption.escapeSequence, receipt.sequence);
  assert.ok(result.interruption.outputSequence > receipt.writeOutputSequence);
  assert.equal(result.interruption.ready, true);
  assert.deepEqual(writes, ["\x1b"]);
});

for (const text of ["[Request interrupted by user] followed by another request", "<task>Another user request.</task>"])
  test(`Escape does not authorize ordinary user text as native interruption evidence: ${text}`, async t => {
    const { session, render, events } = await setup(t);
    const pending = session.submit("synthetic", { timeoutMs: 1000 });
    const failed = assert.rejects(pending, /Unrelated root messages in native turn/);
    await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
    await session.escape({ purpose: "test-interrupt" });
    events.push(user(text));
    await render("❯");
    await failed;
    assert.equal(session.activeSubmit, false);
  });

test("stale interruption redraw never becomes proof of a new interruption", async t => {
  const { session, render } = await setup(t, marker + "\n❯");
  const controller = new AbortController();
  const pending = session.submit("synthetic", { timeoutMs: 1000, signal: controller.signal });
  const failed = assert.rejects(pending, { name: "AbortError" });
  await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
  await session.escape({ purpose: "test-interrupt" });
  await render("❯"); // Split erase/repaint is not a new native marker.
  await render(marker + "\n❯");
  assert.equal(session.currentTurn.renderedReceipt, null);
  controller.abort(); await failed;
  assert.equal(session.activeSubmit, false);
});

test("normal completion followed by Escape remains completion and retains sidechain evidence", async t => {
  const { session, render, events } = await setup(t);
  const pending = session.submit("synthetic", { timeoutMs: 1000 });
  await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
  events.push({ uuid: "child", type: "assistant", isSidechain: true, parent_tool_use_id: "child", message: { content: [], stop_reason: "end_turn" } });
  events.push({ uuid: "answer", parentUuid: "synthetic", type: "assistant", message: { id: "msg", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } });
  await session.escape({ purpose: "test-interrupt" }); await render("done\n❯");
  const result = await pending;
  assert.equal(result.interrupted, false);
  assert.equal(result.interruption, null);
  assert.ok(result.events.some(e => e.uuid === "child"));
});

test("observer cancellation releases the active turn without closing the CLI", async t => {
  const { session } = await setup(t), controller = new AbortController();
  const pending = session.submit("synthetic", { signal: controller.signal });
  const failed = assert.rejects(pending, { name: "AbortError" });
  await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
  controller.abort(); await failed;
  assert.equal(session.activeSubmit, false); assert.equal(session.currentTurn, null);
  assert.equal(session.closing, undefined);
});

test("cancellation interrupts a stalled rendering wait", async t => {
  const { session } = await setup(t), controller = new AbortController();
  session.writeQueue = new Promise(() => {});
  const pending = session.waitFor(() => assert.fail("must not run"), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
});

test("startup quiet window requires drained output and device acknowledgments", t => {
  const session = new InteractiveSession({ timeoutMs: 2000 });
  t.after(() => session.terminal.dispose());
  const now = Date.now();
  session.lastOutputAt = now - 500;
  assert.equal(session.renderDrained(1000), false);
  session.lastOutputAt = now - 2000;
  assert.equal(session.renderDrained(1000), true);
  session.pendingInputs.set(1, {});
  assert.equal(session.renderDrained(1000), false);
  session.pendingInputs.clear(); session.outputSequence = 1;
  assert.equal(session.renderDrained(1000), false);
});

test("input receipts contain metadata, not input text, and allow only one test Escape", async t => {
  const { session } = await setup(t);
  const receipt = await session.writeInput("PRIVATE_SYNTHETIC", { kind: "paste", purpose: "native-input" });
  assert.equal(receipt.accepted, true); assert.equal(receipt.byteCount, 17);
  assert.ok(!JSON.stringify(session.inputReceipts).includes("PRIVATE_SYNTHETIC"));
  session.currentTurn = {};
  await session.escape({ purpose: "test-interrupt" });
  await assert.rejects(session.escape({ purpose: "test-interrupt" }), /Only one/);
});

test("Escape requires an explicit known purpose and writes nothing otherwise", async t => {
  const { session, writes } = await setup(t);
  for (const options of [undefined, {}, { purpose: "picker-dismissal" }, { purpose: "transport" }]) {
    await assert.rejects(session.escape(options), TypeError);
  }
  assert.deepEqual(writes, []); assert.deepEqual(session.inputReceipts, []);
  const receipt = await session.escape({ purpose: "picker-dismiss" });
  assert.equal(receipt.purpose, "picker-dismiss"); assert.deepEqual(writes, ["\x1b"]);
});

test("every Escape the harness writes carries one of four purposes, mcp-dismiss included", () => {
  const dir = new URL("../scripts/verify/", import.meta.url), purposes = new Set();
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(new URL(name, dir), "utf8");
    for (const [, purpose] of source.matchAll(/kind: "escape", purpose: "([^"]+)"/g)) purposes.add(purpose);
    for (const purpose of JSON.parse(/ESCAPE_PURPOSES = (\[[^\]]*\])/.exec(source)?.[1] ?? "[]")) purposes.add(purpose);
  }
  assert.deepEqual([...purposes].sort(), ["cleanup", "mcp-dismiss", "picker-dismiss", "test-interrupt"]);
});

// The paragraph (list item or line run) around needle, whitespace collapsed.
const paragraph = (file, needle) => {
  const text = fs.readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8"), at = text.indexOf(needle);
  assert.notEqual(at, -1, `${file} lacks ${needle}`);
  const start = Math.max(text.lastIndexOf("\n- ", at), text.lastIndexOf("\n\n", at));
  const ends = ["\n- ", "\n\n"].map(edge => text.indexOf(edge, at)).filter(i => i !== -1);
  return text.slice(start, Math.min(...ends, text.length)).replace(/\s+/g, " ");
};

test("an interruption receipt row holds the rendered screen and native record, as DIAGNOSTICS and TESTING say", async t => {
  const { session, render, events } = await setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-native-turn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  session.receiptsPath = path.join(dir, "terminal-events.jsonl");
  const pending = session.submit("synthetic", { timeoutMs: 1000 });
  await session.waitFor(() => session.activity().interruptible, { timeoutMs: 500 });
  await session.escape({ purpose: "test-interrupt" });
  events.push({ ...user("[Request interrupted by user]"), cwd: "/private/tmp/verify-cwd", sessionId: "session-x" });
  await render("❯ synthetic\nPARTIAL_REPLY_MARKER\n❯");
  assert.equal((await pending).interrupted, true);
  const rows = fs.readFileSync(session.receiptsPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const [row, ...extra] = rows.filter(r => r.kind === "interruption");
  assert.equal(extra.length, 0);
  assert.match(row.screen, /❯ synthetic\nPARTIAL_REPLY_MARKER/);
  assert.equal(row.nativeReceipt.event.cwd, "/private/tmp/verify-cwd");
  assert.ok(rows.filter(r => r !== row).every(r => !JSON.stringify(r).includes("PARTIAL_REPLY_MARKER")));
  const en = paragraph("DIAGNOSTICS.md", "`terminal-events-<launchId>.jsonl`");
  const ko = paragraph("DIAGNOSTICS_KO.md", "`terminal-events-<launchId>.jsonl`");
  assert.match(en, /interruption row[^.]*rendered screen text[^.]*`cwd` and session ID[^.]*like the raw log/);
  assert.match(ko, /Escape 중단 행[^.]*렌더링된 화면 텍스트/);
  assert.match(ko, /`cwd`와 세션 ID[^.]*원시 로그처럼 검토/);
  assert.match(paragraph("TESTING.md", "each Escape is labelled"), /interruption row also holds the rendered screen/);
  assert.match(paragraph("TESTING_KO.md", "Escape마다"), /중단 행에는[^.]*렌더링된 화면/);
});

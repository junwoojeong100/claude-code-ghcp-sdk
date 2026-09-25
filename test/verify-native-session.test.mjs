/** On-disk native session ownership tests; synthetic transcripts and terminal output only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { InteractiveSession, normalizeNativeEvent } from "../scripts/verify/interactive.mjs";

// Keep the old session lexically last to expose adoption based on directory order.
const OWNED = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NEXT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CLEAR = "<command-name>/clear</command-name>";

async function fixture(t, tmpDir = os.tmpdir()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, "native-session-test-")));
  const workspace = path.join(root, "workspace"), configDir = path.join(root, "config");
  const project = path.join(configDir, "projects", "project");
  fs.mkdirSync(workspace);
  fs.mkdirSync(project, { recursive: true });
  const session = new InteractiveSession({ workspace, configDir, sessionId: OWNED, timeoutMs: 5000 });
  session.startedAt = Date.now();
  const operations = [];
  t.after(async () => {
    await Promise.allSettled(operations);
    await session.writeQueue;
    session.terminal.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = id => path.join(project, `${id}.jsonl`);
  const append = (id, ...events) => fs.appendFileSync(file(id), events.map(e => JSON.stringify(e) + "\n").join(""));
  const user = (uuid, content, extra = {}) => ({ uuid, parentUuid: null, sessionId: OWNED, cwd: workspace,
    isSidechain: false, type: "user", message: { role: "user", content }, ...extra });
  const assistant = (uuid, parentUuid, extra = {}) => ({ uuid, parentUuid, sessionId: OWNED, cwd: workspace,
    isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn" }, ...extra });
  const clear = (id, type = "user", extra = {}) => type === "user"
    ? user(`clear-${id}`, CLEAR, { sessionId: id, ...extra })
    : { uuid: `clear-${id}`, parentUuid: null, sessionId: id, cwd: workspace, isSidechain: false,
      type: "system", subtype: "local_command", content: CLEAR, ...extra };
  const boundary = (extra = {}) => ({ uuid: "boundary", parentUuid: null, sessionId: OWNED, cwd: workspace,
    isSidechain: false, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 1200 }, ...extra });
  const summary = (extra = {}) => user("summary", "Synthetic compacted context.",
    { parentUuid: "boundary", isCompactSummary: true, ...extra });
  const render = text => session.receiveOutput(Buffer.from("\x1b[2J\x1b[H" + text.replaceAll("\n", "\r\n")), session.outputSequence + 1);
  function enter(expected, write, screen = "❯") {
    session.enter = async text => {
      assert.equal(text, expected);
      const receipt = { accepted: true, renderSequence: session.renderSequence, writeOutputSequence: session.outputSequence };
      await write();
      if (screen !== null) await render(screen);
      return receipt;
    };
  }
  function observe(operation) {
    let polls = 0, settled = false;
    const freshEvents = session.freshEvents.bind(session);
    session.freshEvents = (...args) => { polls++; return freshEvents(...args); };
    const promise = operation();
    operations.push(promise);
    promise.then(() => { settled = true; }, () => { settled = true; });
    return { promise, async assertPending() {
      // Observe multiple real command predicates instead of guessing a flush delay.
      await session.waitFor(() => polls >= 2 || settled, { timeoutMs: 500, label: "synthetic native polling" });
      assert.equal(settled, false, "incomplete native evidence must not settle the operation");
      assert.ok(polls >= 2);
    } };
  }
  append(OWNED, user("existing", "Previous owned turn."));
  await render("❯");
  return { session, workspace, file, append, user, assistant, clear, boundary, summary, render, enter, observe };
}

const ids = events => events.map(e => e.uuid);

test("snapshot preserves UUID/hash freshness and the set of already-existing transcript files", async t => {
  const f = await fixture(t);
  const noUuid = { type: "system", subtype: "local_command", sessionId: OWNED, cwd: f.workspace, content: "previous" };
  f.append(OWNED, noUuid);
  f.append(OTHER); // An empty file is still a pre-existing session, not a /clear transition.
  const before = f.session.snapshot();
  assert.ok(before instanceof Set);
  assert.ok(before.has("existing"));
  assert.ok(before.has(createHash("sha256").update(JSON.stringify(normalizeNativeEvent(noUuid))).digest("hex")));
  assert.ok(before.files instanceof Set);
  assert.deepEqual([...before.files].sort(), [f.file(OWNED), f.file(OTHER)].sort());
  f.append(NEXT, f.clear(NEXT));
  assert.equal(before.files.has(f.file(NEXT)), false, "snapshot file ownership must not mutate after discovery");
});

for (const oldFlushLast of [false, true]) test(`delayed old-session flush cannot replace the current owner (old flush last: ${oldFlushLast})`, async t => {
  const f = await fixture(t);
  f.append(NEXT, f.user("current-existing", "Current turn.", { sessionId: NEXT }));
  f.session.sessionId = NEXT;
  const before = f.session.snapshot();
  const old = () => f.append(OWNED, f.assistant("old-delayed", "existing"));
  const current = () => f.append(NEXT, f.assistant("current-fresh", "current-existing", { sessionId: NEXT }));
  for (const flush of oldFlushLast ? [current, old] : [old, current]) flush();
  assert.deepEqual(ids(f.session.freshEvents(before)), ["current-fresh"]);
  assert.equal(f.session.sessionId, NEXT);
  assert.equal(f.session.transcriptPath, f.file(NEXT));
});

for (const markerType of ["user", "system"]) test(`/clear adopts exactly the new owned ${markerType} marker despite delayed old records`, async t => {
  const f = await fixture(t);
  f.enter("/clear", () => {
    f.append(NEXT, f.clear(NEXT, markerType));
    f.append(OTHER, f.user("unrelated", "A different conversation.", { sessionId: OTHER }));
    f.append(OWNED, f.assistant("old-delayed", "existing"));
  });
  const result = await f.session.command("/clear", { timeoutMs: 1000 });
  assert.equal(result.sessionId, NEXT);
  assert.equal(result.transcriptPath, f.file(NEXT));
  assert.deepEqual(ids(result.events), [`clear-${NEXT}`]);
  const before = f.session.snapshot();
  f.append(OWNED, f.assistant("old-even-later", "old-delayed"));
  assert.deepEqual(f.session.freshEvents(before), []);
  assert.equal(f.session.sessionId, NEXT);
});

for (const canonicalOption of [false, true]) test(`/clear accepts canonical workspace identity (canonical option: ${canonicalOption})`, async t => {
  const tmpDir = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const f = await fixture(t, tmpDir), root = path.dirname(f.workspace);
  let alias = path.join(tmpDir, path.basename(root), "workspace");
  if (alias === f.workspace) {
    // Exercise an ancestor alias even on platforms without /tmp -> /private/tmp.
    const aliasRoot = path.join(root, "alias");
    fs.symlinkSync(root, aliasRoot, "dir");
    alias = path.join(aliasRoot, "workspace");
  }
  assert.notEqual(alias, f.workspace);
  assert.equal(fs.realpathSync(alias), f.workspace);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), false, "the workspace itself is still an owned directory");
  f.session.options.workspace = canonicalOption ? f.workspace : alias;
  f.enter("/clear", () => f.append(NEXT, f.clear(NEXT, "user", { cwd: canonicalOption ? alias : f.workspace })));
  const result = await f.session.command("/clear", { timeoutMs: 1000 });
  assert.equal(result.sessionId, NEXT);
  assert.deepEqual(ids(result.events), [`clear-${NEXT}`]);
});

test("/clear rejects a different existing directory even when its path uses an alias", async t => {
  const f = await fixture(t), root = path.dirname(f.workspace);
  const foreign = path.join(root, "foreign"), aliasRoot = path.join(root, "alias");
  fs.mkdirSync(foreign);
  fs.symlinkSync(root, aliasRoot, "dir");
  const before = f.session.snapshot();
  f.append(NEXT, f.clear(NEXT, "user", { cwd: path.join(aliasRoot, "foreign") }));
  assert.deepEqual(f.session.freshEvents(before, { clearFrom: OWNED }), []);
  assert.equal(f.session.sessionId, OWNED);
});

for (const invalid of ["no marker", "foreign cwd", "mismatched session", "sidechain", "child tool", "embedded marker", "pre-existing file"])
  test(`/clear ignores a new candidate with ${invalid}`, async t => {
    const f = await fixture(t);
    if (invalid === "pre-existing file") f.append(NEXT);
    const before = f.session.snapshot();
    const extra = invalid === "foreign cwd" ? { cwd: path.join(f.workspace, "foreign") }
      : invalid === "mismatched session" ? { sessionId: OTHER }
      : invalid === "sidechain" ? { isSidechain: true, agentId: "child" }
      : invalid === "child tool" ? { parent_tool_use_id: "tool-child" }
      : invalid === "embedded marker" ? { message: { role: "user", content: `Not a command: ${CLEAR}` } }
      : invalid === "no marker" ? { message: { role: "user", content: "Unrelated conversation." } } : {};
    f.append(NEXT, f.clear(NEXT, "user", extra));
    assert.deepEqual(f.session.freshEvents(before, { clearFrom: OWNED }), []);
    assert.equal(f.session.sessionId, OWNED);
    assert.equal(f.session.transcriptPath, f.file(OWNED));
  });

test("a /clear marker in another file is never adopted outside an explicit clear transition", async t => {
  const f = await fixture(t), before = f.session.snapshot();
  f.append(NEXT, f.clear(NEXT));
  assert.deepEqual(f.session.freshEvents(before), []);
  assert.equal(f.session.sessionId, OWNED);
});

test("unrelated new session plus idle terminal cannot complete /clear", async t => {
  const f = await fixture(t);
  f.enter("/clear", () => f.append(NEXT, f.user("foreign", "New unrelated session.", { sessionId: NEXT })));
  await assert.rejects(f.session.command("/clear", { timeoutMs: 180 }), error => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.result.sessionId, OWNED);
    return true;
  });
});

test("multiple new owned /clear markers fail as ambiguous without changing the owner", async t => {
  const f = await fixture(t);
  f.enter("/clear", () => {
    f.append(NEXT, f.clear(NEXT));
    f.append(OTHER, f.clear(OTHER, "system"));
  });
  await assert.rejects(f.session.command("/clear", { timeoutMs: 1000 }), /ambig/i);
  assert.equal(f.session.sessionId, OWNED);
});

test("compact boundary alone cannot complete until its linked user summary arrives", async t => {
  const f = await fixture(t);
  f.enter("/compact", () => f.append(OWNED, f.boundary()));
  const pending = f.observe(() => f.session.command("/compact", { timeoutMs: 1000 }));
  await pending.assertPending();
  // Native sessionId wins over a stale request session_id embedded in the summary.
  f.append(OWNED, f.summary({ session_id: OTHER }));
  const result = await pending.promise;
  assert.deepEqual(ids(result.events), ["boundary", "summary"]);
  assert.equal(result.events[1].session_id, OWNED);
});

for (const invalid of ["foreign file", "foreign session", "unlinked", "non-user role", "empty content", "sidechain"])
  test(`compact ignores a ${invalid} summary until a valid linked one arrives`, async t => {
    const f = await fixture(t);
    f.enter("/compact", () => {
      f.append(OWNED, f.boundary());
      const extra = invalid === "foreign file" || invalid === "foreign session" ? { sessionId: OTHER }
        : invalid === "unlinked" ? { parentUuid: "different-boundary" }
        : invalid === "non-user role" ? { message: { role: "assistant", content: "Not a user summary." } }
        : invalid === "empty content" ? { message: { role: "user", content: "" } }
        : { isSidechain: true, agentId: "child" };
      f.append(invalid === "foreign file" ? OTHER : OWNED, f.summary({ uuid: "invalid-summary", ...extra }));
    });
    const pending = f.observe(() => f.session.command("/compact", { timeoutMs: 1000 }));
    await pending.assertPending();
    f.append(OWNED, f.summary());
    const result = await pending.promise;
    assert.equal(result.sessionId, OWNED);
    assert.ok(result.events.some(e => e.uuid === "summary"));
  });

for (const invalid of ["missing summary", "unlinked summary", "automatic boundary", "child boundary", "duplicate boundary", "duplicate summary"])
  test(`compact with ${invalid} times out rather than declaring success`, async t => {
    const f = await fixture(t);
    f.enter("/compact", () => {
      f.append(OWNED, f.boundary(invalid === "automatic boundary" ? { compactMetadata: { trigger: "auto", preTokens: 1200 } }
        : invalid === "child boundary" ? { isSidechain: true, agentId: "child" } : {}));
      if (invalid !== "missing summary") f.append(OWNED, f.summary(invalid === "unlinked summary" ? { parentUuid: "other-boundary" } : {}));
      if (invalid === "duplicate boundary") f.append(OWNED, f.boundary({ uuid: "second-boundary" }));
      if (invalid === "duplicate summary") f.append(OWNED, f.summary({ uuid: "second-summary" }));
    });
    await assert.rejects(f.session.command("/compact", { timeoutMs: 180 }), { code: "ETIMEDOUT" });
  });

for (const screen of [null, "Compacting conversation\nesc to interrupt\n❯"])
  test(`compact requires a fresh idle render, not ${screen === null ? "the pre-command prompt" : "an active compact screen"}`, async t => {
    const f = await fixture(t);
    f.enter("/compact", () => f.append(OWNED, f.boundary(), f.summary()), screen);
    const pending = f.observe(() => f.session.command("/compact", { timeoutMs: 1000 }));
    await pending.assertPending();
    await f.render("Compacted\n❯");
    assert.deepEqual(ids((await pending.promise).events), ["boundary", "summary"]);
  });

test("submit waits for the owned prompt's descendant completion and preserves native child evidence", async t => {
  const f = await fixture(t), prompt = "Exact owned prompt.";
  f.enter(prompt, () => {
    f.append(OWNED, f.user("prompt", prompt));
    f.append(OWNED, f.assistant("child-answer", "prompt", { isSidechain: true, agentId: "child" }));
    f.append(OTHER, f.user("foreign-prompt", prompt, { sessionId: OTHER }),
      f.assistant("foreign-answer", "foreign-prompt", { sessionId: OTHER }));
  });
  const pending = f.observe(() => f.session.submit(prompt, { timeoutMs: 1000 }));
  await pending.assertPending();
  // Disk order can be reversed; completion still needs the full UUID ancestry.
  f.append(OWNED, f.assistant("answer", "tool-result"),
    f.user("tool-result", [{ type: "tool_result", tool_use_id: "read", content: "content" }], { parentUuid: "tool-call" }),
    f.assistant("tool-call", "prompt", { message: { role: "assistant", content: [
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "synthetic.txt" } }], stop_reason: "tool_use" } }));
  const result = await pending.promise;
  assert.equal(result.sessionId, OWNED);
  assert.deepEqual(ids(result.events), ["prompt", "child-answer", "tool-call", "tool-result", "answer"]);
  assert.equal(result.events.find(e => e.uuid === "child-answer").parent_tool_use_id, "child");
  assert.equal(result.interrupted, false);
});

test("recovery ignores late-flushed ancestors through already-persisted history", async t => {
  const f = await fixture(t), prompt = "Recover after interruption.";
  // Persist a linking record before the snapshot, with its ancestors still
  // buffered. Resolving ancestry from fresh events alone cannot cross this link.
  f.append(OWNED, { uuid: "persisted-link", parentUuid: "late-interruption", sessionId: OWNED,
    cwd: f.workspace, isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 50 });
  f.enter(prompt, () => {
    f.append(OWNED, f.user("recovery-prompt", prompt, { parentUuid: "persisted-link" }));
    f.append(OWNED, f.user("late-interruption", "[Request interrupted by user]", { parentUuid: "late-answer" }),
      f.assistant("late-answer", "existing"));
  });
  const pending = f.observe(() => f.session.submit(prompt, { timeoutMs: 1000 }));
  await pending.assertPending(); // The old end_turn must not complete recovery.
  f.append(OWNED, f.assistant("recovery-answer", "recovery-prompt", {
    message: { role: "assistant", content: [{ type: "text", text: "Recovered." }], stop_reason: "end_turn" },
  }));
  const result = await pending.promise;
  assert.deepEqual(ids(result.events), ["recovery-prompt", "recovery-answer"]);
  assert.equal(result.answer, "Recovered.");
  assert.equal(result.sessionId, OWNED);
  assert.equal(result.interrupted, false);
  assert.equal(result.interruption, null);
  assert.deepEqual(ids(f.session.readEvents()), ["existing", "late-answer", "late-interruption", "persisted-link",
    "recovery-prompt", "recovery-answer"], "ancestor filtering must not discard the native transcript");
});

for (const type of ["assistant", "user"]) test(`submit rejects unrelated same-session root ${type} evidence`, async t => {
  const f = await fixture(t), prompt = "Exact owned prompt.";
  // Complete the owned chain before judging unrelated roots: earlier flushes may
  // legitimately arrive before their linking parents have reached disk.
  f.enter(prompt, () => f.append(OWNED, f.user("prompt", prompt), f.assistant("answer", "prompt"), type === "assistant"
    ? f.assistant("unrelated", "existing") : f.user("unrelated", "A different prompt.", { parentUuid: "existing" })));
  await assert.rejects(f.session.submit(prompt, { timeoutMs: 1000 }), error => {
    assert.match(error.message, /Unrelated root messages in native turn/,
      "unrelated root evidence must fail the ownership check, not time out or throw an incidental error");
    assert.ok(error.result, "the rejection must retain native evidence");
    assert.ok(error.result.events.some(e => e.uuid === "unrelated"));
    return true;
  });
});

for (const ownAnswer of [false, true]) for (const nextPrompt of ["A competing ordinary turn.", "<task>Another ordinary turn.</task>"])
  test(`submit rejects a subsequent ordinary user (own answer: ${ownAnswer}, angle text: ${nextPrompt.startsWith("<")})`, async t => {
    const f = await fixture(t), prompt = "First owned prompt.";
    f.enter(prompt, () => {
      f.append(OWNED, f.user("u1", prompt, { parentUuid: "existing" }));
      if (ownAnswer) f.append(OWNED, f.assistant("a1", "u1"));
      f.append(OWNED, f.user("u2", nextPrompt, { parentUuid: ownAnswer ? "a1" : "u1" }), f.assistant("a2", "u2"));
    });
    await assert.rejects(f.session.submit(prompt, { timeoutMs: 1000 }), error => {
      assert.match(error.message, /Unrelated root messages in native turn/);
      assert.ok(error.result.events.some(e => e.uuid === "u2"));
      assert.ok(error.result.events.some(e => e.uuid === "a2"));
      assert.equal(error.result.interrupted, false);
      return true;
    });
  });

test("submit traverses tool-result, metadata and exact native interruption users", async t => {
  const f = await fixture(t), prompt = "Continue through native intermediaries.";
  f.enter(prompt, () => f.append(OWNED,
    f.user("prompt", prompt, { parentUuid: "existing" }),
    f.assistant("tool-call", "prompt", { message: { role: "assistant", content: [
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "synthetic.txt" } }], stop_reason: "tool_use" } }),
    f.user("tool-result", [{ type: "tool_result", tool_use_id: "read", content: "content" }], { parentUuid: "tool-call" }),
    f.user("metadata", "Native metadata.", { parentUuid: "tool-result", isMeta: true }),
    f.user("interrupted", "[Request interrupted by user]", { parentUuid: "metadata" }),
    f.assistant("answer", "interrupted"),
    f.user("child-user", "A sidechain prompt.", { parentUuid: "prompt", isSidechain: true, agentId: "child" }),
    f.assistant("child-answer", "child-user", { isSidechain: true, agentId: "child" }),
    f.user("tool-child-user", "A child tool prompt.", { parentUuid: "prompt", parent_tool_use_id: "child-tool" })));
  const result = await f.session.submit(prompt, { timeoutMs: 1000 });
  assert.equal(result.answer, "done");
  assert.equal(result.interrupted, false, "an interruption record without acknowledged Escape is not interruption evidence");
  assert.deepEqual(ids(result.events), ["prompt", "tool-call", "tool-result", "metadata", "interrupted", "answer",
    "child-user", "child-answer", "tool-child-user"]);
  assert.equal(result.events.find(e => e.uuid === "child-user").parent_tool_use_id, "child");
  assert.equal(result.events.find(e => e.uuid === "tool-child-user").parent_tool_use_id, "child-tool");
});

test("submit waits for a missing ancestor link even with both old and new completed answers on disk", async t => {
  const f = await fixture(t), prompt = "Recover while ancestry is still flushing.";
  f.enter(prompt, () => f.append(OWNED, f.assistant("old-answer", "existing"),
    f.user("prompt", prompt, { parentUuid: "missing-link" }), f.assistant("new-answer", "prompt")));
  const pending = f.observe(() => f.session.submit(prompt, { timeoutMs: 1000 }));
  await pending.assertPending();
  f.append(OWNED, { uuid: "missing-link", parentUuid: "old-answer", sessionId: OWNED, cwd: f.workspace,
    isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 50 });
  const result = await pending.promise;
  assert.deepEqual(ids(result.events), ["prompt", "new-answer"]);
  assert.equal(result.answer, "done");
  assert.deepEqual(ids(f.session.readEvents()), ["existing", "old-answer", "missing-link", "prompt", "new-answer"]);
});

test("submit times out rather than accepting or rejecting a permanently missing ancestor link", async t => {
  const f = await fixture(t), prompt = "Unresolved ancestry.";
  f.enter(prompt, () => f.append(OWNED, f.assistant("old-answer", "existing"),
    f.user("prompt", prompt, { parentUuid: "missing-link" }), f.assistant("new-answer", "prompt")));
  await assert.rejects(f.session.submit(prompt, { timeoutMs: 180 }), error => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.result.timedOut, true);
    assert.deepEqual(ids(error.result.events), ["old-answer", "prompt", "new-answer"]);
    return true;
  });
});

test("a fully resolved unrelated root remains an ownership error", async t => {
  const f = await fixture(t), prompt = "Resolved owned ancestry.";
  f.enter(prompt, () => f.append(OWNED, f.assistant("unrelated-root", null),
    f.user("prompt", prompt, { parentUuid: "existing" }), f.assistant("answer", "prompt")));
  await assert.rejects(f.session.submit(prompt, { timeoutMs: 1000 }), /Unrelated root messages in native turn/);
});

test("submit accepts a native compact boundary that intentionally resets ancestry to null", async t => {
  const f = await fixture(t), prompt = "After compact.";
  f.enter(prompt, () => f.append(OWNED, f.boundary(), f.summary(),
    f.user("prompt", prompt, { parentUuid: "summary" }), f.assistant("answer", "prompt")));
  assert.deepEqual(ids((await f.session.submit(prompt, { timeoutMs: 1000 })).events), ["prompt", "answer"]);
});

test("submit rejects cyclic native ancestry", async t => {
  const f = await fixture(t), prompt = "Cyclic ancestry.";
  f.enter(prompt, () => f.append(OWNED, f.user("prompt", prompt, { parentUuid: "link" }),
    { uuid: "link", parentUuid: "prompt", sessionId: OWNED, cwd: f.workspace, type: "system" },
    f.assistant("answer", "prompt")));
  await assert.rejects(f.session.submit(prompt, { timeoutMs: 1000 }), /Cycle in native/);
});

test("submit does not bind a prompt substring from another turn", async t => {
  const f = await fixture(t), prompt = "Exact owned prompt.";
  f.enter(prompt, () => f.append(OWNED, f.user("different-prompt", `Quoted: ${prompt}`), f.assistant("different-answer", "different-prompt")));
  await assert.rejects(f.session.submit(prompt, { timeoutMs: 180 }), { code: "ETIMEDOUT" });
});

/** Summary linkage must not accept unrelated completions or a bare boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { compactLinkChecks } from "../scripts/verify/scenario-checks.mjs";
import { evaluateStoredSlot } from "../scripts/verify/drivers.mjs";
import { normalizeNativeEvent } from "../scripts/verify/interactive.mjs";
import { verificationRequest, verificationCompactSummarySha256 } from "../src/verification-observer.mjs";
import { digest } from "../scripts/verify/fixtures.mjs";
import { compactRun, makeSlot } from "./fixtures/verify-evidence.mjs";

const request = run => run.observations.find(r => r.event === "bridge.verify_request");
const completed = run => run.observations.find(r => r.event === "bridge.turn_completed");

test("compact summary links native parent, session, transcript and response digest", () => {
  const result = compactLinkChecks(compactRun());
  assert.equal(result.outcome, "pass", result.reason);
  assert.equal(result.responseId, "summary-response");
});

for (const [name, mutate] of [
  ["bare boundary", r => { r.events.pop(); }],
  ["foreign boundary session", r => { r.events[0].sessionId = "other"; }],
  ["automatic compaction", r => { r.events[0].compactMetadata.trigger = "auto"; }],
  ["foreign summary session", r => { r.events[1].sessionId = "other"; }],
  ["unlinked summary parent", r => { r.events[1].parentUuid = "other"; }],
  ["sidechain summary", r => { r.events[1].isSidechain = true; }],
  ["different summary contents", r => { r.events[1].message.content = r.events[1].message.content.replace("Synthetic", "Altered"); }],
  ["foreign transcript path", r => { r.transcriptPath = "/other/session-one.jsonl"; }],
  ["missing response digest", r => { delete completed(r).compactSummarySha256; }],
  ["duplicate matching completion", r => { r.observations.push({ ...completed(r) }); }],
  ["foreign request session", r => { request(r).claudeSessionId = "other"; }],
  ["ordinary request", r => { request(r).compactRequested = false; }],
  ["sidechain request", r => { request(r).claudeAgent = "subagent"; }],
  ["unrelated response ID", r => { request(r).responseId = "other"; }],
]) test(`compaction rejects ${name}`, () => {
  const run = compactRun(); mutate(run);
  assert.notEqual(compactLinkChecks(run).outcome, "pass");
});

test("resume must preserve the summary as well as its boundary", t => {
  const slot = makeSlot(t, "V06");
  assert.equal(evaluateStoredSlot(slot).outcome, "pass");
  slot.evidence.facts.resumedHistory.pop();
  const result = evaluateStoredSlot(slot);
  assert.equal(result.outcome, "fail");
  assert.ok(result.checks.some(c => c.name === "resume includes saved compact summary" && !c.ok));
});

test("native conversation ID overrides a stale compact-summary embedded ID", () => {
  assert.equal(normalizeNativeEvent({ sessionId: "native", session_id: "old", isCompactSummary: true }).session_id, "native");
});

test("summary digest follows native normalization without retaining response text", () => {
  assert.equal(verificationCompactSummarySha256("<analysis>private analysis</analysis>\n\n<summary> retained\n\n\nlabel </summary>"), digest("Summary:\nretained\n\nlabel"));
  assert.equal(verificationCompactSummarySha256("plain summary"), digest("plain summary"));
  assert.equal(verificationCompactSummarySha256(null), null);
  assert.equal(verificationCompactSummarySha256("  "), null);
});

test("compact request marker depends on current instruction, not earlier history", () => {
  const instruction = "Your task is to create a detailed summary of the conversation so far, preserving facts.";
  const body = { messages: [{ role: "user", content: [{ type: "text", text: instruction }] }] };
  const ids = { requestId: "request", responseId: "response" };
  assert.equal(verificationRequest(body, {}, ids).compactRequested, true);
  body.messages.push({ role: "user", content: "Recall the label" });
  const observed = verificationRequest(body, {}, ids);
  assert.equal(observed.compactRequested, false);
  assert.ok(!JSON.stringify(observed).includes(instruction));
});

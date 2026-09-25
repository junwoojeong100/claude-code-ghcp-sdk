/** Mock-provider and builtin-origin regressions; no real CLI or paid traffic. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinPlugins, preflightCheck, writePreflightSettings } from "../scripts/verify/preflight.mjs";
import { startLocalAPI, LOCAL_TOKEN } from "./fixtures/verify-local-api.mjs";

const request = (api, messages) => fetch(`${api.baseUrl}/v1/messages`, { method: "POST",
  headers: { "content-type": "application/json", "x-api-key": LOCAL_TOKEN },
  body: JSON.stringify({ model: "claude-sonnet-5", stream: false, messages,
    tools: [{ name: "mcp__fixture__lookup", input_schema: { type: "object" } }] }) }).then(r => r.json());

test("failed preflight dependencies stop further input but not independent checks or cleanup", async () => {
  const result = { checks: {} }, calls = [];
  await preflightCheck(result, "first", async () => { calls.push("first"); throw new Error("first failed"); });
  await preflightCheck(result, "dependent", async () => calls.push("dependent"), ["first"]);
  await preflightCheck(result, "chained", async () => calls.push("chained"), ["dependent"]);
  await preflightCheck(result, "cleanup", async () => calls.push("cleanup"));
  await preflightCheck(result, "independent", async () => calls.push("independent"));
  assert.deepEqual(calls, ["first", "cleanup", "independent"]);
  assert.equal(result.checks.dependent.skipped, true);
  assert.match(result.checks.chained.reason, /Prerequisite failed: dependent/);
  assert.equal(result.checks.cleanup.ok, true);
  assert.equal(result.checks.independent.ok, true);
  await preflightCheck(result, "available", async () => calls.push("available"), ["independent"]);
  assert.equal(result.checks.available.ok, true);
});

test("preflight launches keep the production Bearer credential path", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-preflight-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  writePreflightSettings(settingsPath, { baseUrl: "http://127.0.0.1:4999", token: LOCAL_TOKEN }, "claude-sonnet-5");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, LOCAL_TOKEN); assert.equal(settings.env.ANTHROPIC_API_KEY, "");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4999");
  assert.equal(settings.autoMemoryEnabled, false); assert.equal(settings.disableAllHooks, true);
  assert.deepEqual(settings.hooks, {}); assert.deepEqual(settings.enabledPlugins, {});
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
});

test("builtin names do not authorize external paths or duplicates", () => {
  const plugin = { name: "agents-md", path: "builtin", source: "agents-md@builtin" };
  assert.equal(builtinPlugins([plugin]), true);
  assert.equal(builtinPlugins([{ ...plugin, path: "/external" }]), false);
  assert.equal(builtinPlugins([{ ...plugin, source: "agents-md@external" }]), false);
  assert.equal(builtinPlugins([plugin, plugin]), false);
  assert.equal(builtinPlugins(undefined), false);
});

test("MCP mock handles trailing system messages and completes after successful tool result", async () => {
  const api = await startLocalAPI();
  try {
    const messages = [{ role: "user", content: "LOCAL_MCP" }, { role: "system", content: "environment" }];
    const first = await request(api, messages);
    assert.equal(first.content[0].input.key, "missing");
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: first.content[0].id, is_error: true, content: "ENOENT" },
    ] }, { role: "system", content: "usage" });
    const second = await request(api, messages);
    assert.equal(second.content[0].input.key, "selected");
    messages.push({ role: "assistant", content: second.content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: second.content[0].id, content: "PRIVATE_MCP_SAMPLE" },
    ] }, { role: "system", content: "usage" });
    const final = await request(api, messages);
    assert.equal(final.stop_reason, "end_turn"); assert.equal(final.content[0].text, "PRIVATE_MCP_SAMPLE");
  } finally { assert.equal((await api.close()).ok, true); }
});

for (const [prompt, expectedType] of [["LOCAL_DELAYED_STREAM", "text_delta"], ["LOCAL_REASONING_STREAM", "thinking_delta"]]) {
  test(`local stream distinguishes ${prompt} from visible text progress`, async () => {
    const api = await startLocalAPI({ streamIntervalMs: 10, streamDelayMs: 60 });
    const controller = new AbortController();
    let response, source = "";
    try {
      response = await fetch(`${api.baseUrl}/v1/messages`, { method: "POST",
        headers: { "content-type": "application/json", "x-api-key": LOCAL_TOKEN },
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      while (!source.includes(`\"type\":\"${expectedType}\"`)) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "Expected streaming delta before EOF");
        source += decoder.decode(value, { stream: true });
      }
      controller.abort();
      await reader.cancel().catch(() => {});
      const request = api.records.find(r => r.type === "request");
      if (expectedType === "text_delta") {
        const progress = api.records.find(r => r.type === "progress");
        assert.ok(progress.at - request.at >= 60);
        assert.equal(api.records.some(r => r.type === "reasoning"), false);
      } else {
        assert.equal(api.records.some(r => r.type === "progress"), false);
        assert.ok(api.records.some(r => r.type === "reasoning"));
        assert.ok(!source.includes('\"type\":\"text_delta\"'));
      }
      assert.ok(!source.includes("event: message_stop"));
    } finally { controller.abort(); assert.equal((await api.close()).ok, true); }
  });
}

test("local immediate reply ends normally without a long-stream progress record", async () => {
  const api = await startLocalAPI();
  try {
    const response = await fetch(`${api.baseUrl}/v1/messages`, { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": LOCAL_TOKEN },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "LOCAL_REPLY=done" }] }),
      signal: AbortSignal.timeout(3000) });
    assert.match(await response.text(), /event: message_stop/);
    assert.equal(api.records.some(r => r.type === "progress"), false);
  } finally { assert.equal((await api.close()).ok, true); }
});

test("recall after compaction is not mistaken for another summary request", async () => {
  const api = await startLocalAPI();
  try {
    const answer = await request(api, [
      { role: "user", content: "Conversation summary. LOCAL_NONCE=retained_label" },
      { role: "user", content: [{ type: "text", text: "<local-command-stdout>Compacted</local-command-stdout>" }, { type: "text", text: "LOCAL_RECALL" }] },
    ]);
    assert.equal(answer.content[0].text, "retained_label");
    assert.equal(api.records.find(r => r.type === "request").compact, false);
  } finally { assert.equal((await api.close()).ok, true); }
});

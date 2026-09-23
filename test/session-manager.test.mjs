import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicSseStream, startSse, writeJsonMessage } from "../src/anthropic.mjs";
import { SessionManager } from "../src/session-manager.mjs";
import { PRIMARY_MODELS } from "../scripts/verify/scenarios.mjs";

class FakeSession {
  constructor() {
    this.handlers = new Map();
    this.setModelCalls = [];
    this.sendCalls = [];
    this.handledToolCalls = [];
    this.sendImplementation = null;
    this.handlePendingToolCallImplementation = null;
    this.abortImplementation = null;
    this.abortCalls = 0;
    this.disconnectCalls = 0;
    this.disconnectImplementation = null;
    this.rpc = {
      tools: {
        handlePendingToolCall: async (request) => {
          this.handledToolCalls.push(request);
          return (
            (await this.handlePendingToolCallImplementation?.(request)) ?? {
              success: true,
            }
          );
        },
      },
    };
  }

  on(type, handler) {
    const handlers = this.handlers.get(type) || new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => handlers.delete(handler);
  }

  emit(type, data = {}, envelope = {}) {
    for (const handler of this.handlers.get(type) || []) {
      handler({ type, data, ...envelope });
    }
  }

  async send(input) {
    this.sendCalls.push(input);
    if (this.sendImplementation) {
      await this.sendImplementation(input);
      return;
    }
    this.emit("assistant.message", {
      content: "ok",
      toolRequests: [],
      outputTokens: 1,
    });
    this.emit("session.idle");
  }

  async setModel(model, options) {
    this.setModelCalls.push({ model, options });
  }

  async abort() {
    this.abortCalls += 1;
    await this.abortImplementation?.();
  }

  async disconnect() {
    this.disconnectCalls += 1;
    await this.disconnectImplementation?.();
  }
}

class FakeClient {
  constructor(models) {
    this.models = models;
    this.created = [];
    this.deleted = [];
    this.session = new FakeSession();
    this.createSessionImplementation = null;
  }

  async start() {}

  async stop() {}

  async listModels() {
    return this.models;
  }

  async listSessions() {
    return [];
  }

  async deleteSession(sessionId) {
    this.deleted.push(sessionId);
  }

  async createSession(config) {
    this.created.push(config);
    if (this.createSessionImplementation) {
      return this.createSessionImplementation(config);
    }
    return this.session;
  }
}

// The SSE assertions below read the exact bytes Claude Code would receive.
function fakeResponse() {
  return {
    chunks: [],
    ended: false,
    writeHead() {},
    write(value) {
      this.chunks.push(value);
    },
    end(value) {
      if (value) this.chunks.push(value);
      this.ended = true;
    },
  };
}

function sseEvents(response) {
  return response.chunks
    .join("")
    .split(/\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

function request(effort, model = "gpt-5.6-sol") {
  return {
    model,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    output_config: { effort },
  };
}

function transientBudget(tokens) {
  return `<system-reminder>\n<total_tokens>${tokens} tokens left</total_tokens>\n</system-reminder>`;
}

test("SDK context tier and catalogue limits survive creation and effort changes", async () => {
  const limits = { max_context_window_tokens: 1178000, max_prompt_tokens: 1050000, max_output_tokens: 128000 };
  const client = new FakeClient([{ id: "gpt-6-astra", capabilities: {
    limits, supports: { reasoningEffort: true }, supportedReasoningEfforts: ["low", "high"],
  } }]);
  const diagnostics = [];
  const manager = new SessionManager({ baseDirectory: ".", client, onDiagnostic: (event) => diagnostics.push(event) });
  await manager.start();
  try {
    await manager.execute(request("low", "gpt-6-astra"), {});
    assert.equal(client.created[0].contextTier, "long_context");
    assert.deepEqual(client.created[0].modelCapabilities, { limits });
    client.session.emit("session.usage_info", { tokenLimit: 1050000, currentTokens: 400000 });
    client.session.emit("session.usage_info", { tokenLimit: 1050000, currentTokens: 500000 });
    const budget = diagnostics.filter((event) => event.event === "bridge.context_budget");
    assert.equal(budget.length, 1);
    assert.equal(budget[0].tokenLimit, 1050000);
    await manager.execute(request("high", "gpt-6-astra"), {});
    assert.deepEqual(client.session.setModelCalls.at(-1), { model: "gpt-6-astra",
      options: { contextTier: "long_context", modelCapabilities: { limits }, reasoningEffort: "high" } });
  } finally { await manager.stop(); }
});

test("every discovered runtime MCP server is disabled on SDK session create and resume", async () => {
  const client = new FakeClient([{ id: "gpt-6-sol" }]);
  const discoverCalls = [];
  client.rpc = {
    mcp: {
      discover: async (params) => {
        discoverCalls.push(params);
        return {
          servers: [
            { name: "playwright", source: "user", type: "stdio" },
            { name: "azure", source: "plugin", sourcePlugin: "azure", type: "stdio" },
            { name: "playwright", source: "workspace", type: "stdio" },
            { name: "" },
            {},
          ],
        };
      },
    },
  };
  const resumed = [];
  client.resumeSession = async (sessionId, config) => {
    resumed.push({ sessionId, config });
    return new FakeSession();
  };
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-6-sol", client, stateIdleTtlMs: 100,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const headers = { "x-claude-code-session-id": "mcp-disabled" };
  await manager.start();
  try {
    assert.deepEqual(discoverCalls, [{ workingDirectory: process.cwd() }]);
    assert.deepEqual(
      diagnostics.filter((event) => event.event.startsWith("bridge.mcp_")),
      [{ event: "bridge.mcp_servers_disabled", count: 3 }],
    );
    await manager.execute(request(undefined, "gpt-6-sol"), headers);
    assert.deepEqual(client.created[0].disabledMcpServers, ["github-mcp-server", "playwright", "azure"]);
    assert.deepEqual(client.created[0].availableTools, [], "MCP servers were never reachable by the model");
    [...manager.states.values()][0].lastUsedAt = 0;
    await manager.execute(request(undefined, "gpt-6-sol"), headers);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].sessionId, client.created[0].sessionId);
    assert.deepEqual(resumed[0].config.disabledMcpServers, ["github-mcp-server", "playwright", "azure"]);
    assert.equal(discoverCalls.length, 1, "discovery runs once per bridge start, not per session");
  } finally {
    await manager.stop();
  }
});

test("MCP discovery failures keep startup working and still disable the built-in server", async () => {
  const cases = [
    ["rejection", (client) => {
      client.rpc = { mcp: { discover: async () => {
        throw Object.assign(new Error("method not found"), { name: "ResponseError" });
      } } };
    }, [{ event: "bridge.mcp_discovery_failed", error: "ResponseError", message: "method not found" }]],
    ["timeout", (client) => {
      client.rpc = { mcp: { discover: () => new Promise(() => {}) } };
    }, [{ event: "bridge.mcp_discovery_failed", error: "Error", message: "MCP discovery exceeded 20ms" }]],
    ["disconnected rpc", (client) => {
      Object.defineProperty(client, "rpc", { get() { throw new Error("Client is not connected."); } });
    }, []],
    ["no rpc surface", () => {}, []],
  ];
  for (const [label, arrange, expected] of cases) {
    const client = new FakeClient([{ id: "gpt-6-sol" }]);
    arrange(client);
    const diagnostics = [];
    const manager = new SessionManager({
      baseDirectory: "/tmp", preferredModel: "gpt-6-sol", client, mcpDiscoveryTimeoutMs: 20,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await manager.start();
    try {
      assert.deepEqual(diagnostics.filter((event) => event.event.startsWith("bridge.mcp_")), expected, label);
      assert.equal((await manager.execute(request(undefined, "gpt-6-sol"), {})).message.content, "ok", label);
      assert.deepEqual(client.created[0].disabledMcpServers, ["github-mcp-server"], label);
    } finally {
      await manager.stop();
    }
  }
});

for (const [type, data] of [
  ["assistant.message_delta", { deltaContent: "progress" }],
  ["assistant.reasoning_delta", { deltaContent: "reasoning", reasoningId: "r" }],
  ["assistant.tool_call_delta", { inputDelta: "{\"value\":", toolCallId: "t" }],
]) {
  test(`meaningful root ${type} progress prevents an absolute-time cutoff`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const manager = new SessionManager({ baseDirectory: ".", client, turnTimeoutMs: 60, maxTurnDurationMs: 1000 });
    let interval;
    let completion;
    client.session.sendImplementation = async () => {
      client.session.emit("assistant.turn_start");
      interval = setInterval(() => client.session.emit(type, data), 15);
      completion = setTimeout(() => {
        clearInterval(interval);
        client.session.emit("assistant.message", { content: "complete", toolRequests: [] });
        client.session.emit("session.idle");
      }, 170);
    };
    await manager.start();
    try {
      assert.equal((await manager.execute(request(), {})).message.content, "complete");
      assert.equal(client.session.abortCalls, 0);
    } finally { clearInterval(interval); clearTimeout(completion); await manager.stop(); }
  });
}

test("empty and subagent deltas cannot keep a silent root turn alive", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: ".", client, turnTimeoutMs: 50, maxTurnDurationMs: 1000 });
  let interval;
  client.session.sendImplementation = async () => {
    interval = setInterval(() => {
      client.session.emit("assistant.message_delta", { deltaContent: "" });
      client.session.emit("assistant.reasoning_delta", { deltaContent: "child work" }, { agentId: "child" });
      client.session.emit("assistant.tool_call_delta", { inputDelta: "child work" }, { agentId: "child" });
    }, 10);
  };
  await manager.start();
  try {
    await assert.rejects(manager.execute(request(), {}), /Timed out waiting/);
    assert.equal(client.session.abortCalls, 1);
  } finally { clearInterval(interval); await manager.stop(); }
});

test("continuous root progress still has an independent hard deadline", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({ baseDirectory: ".", client, turnTimeoutMs: 80, maxTurnDurationMs: 130,
    onDiagnostic: (event) => diagnostics.push(event) });
  let interval;
  client.session.sendImplementation = async () => {
    interval = setInterval(() => client.session.emit("assistant.message_delta", { deltaContent: "more" }), 10);
  };
  await manager.start();
  try {
    await assert.rejects(manager.execute(request(), {}), /hard duration limit/);
    assert.equal(diagnostics.find((event) => event.event === "bridge.turn_timeout").reason, "duration_limit");
    assert.equal(client.session.abortCalls, 1);
  } finally { clearInterval(interval); await manager.stop(); }
});

test("SDK truncation fails explicitly and the next compacted request starts a fresh session", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const old = client.session;
  const next = new FakeSession();
  client.createSessionImplementation = () => client.created.length === 1 ? old : next;
  const diagnostics = [];
  const manager = new SessionManager({ baseDirectory: ".", client, onDiagnostic: (event) => diagnostics.push(event) });
  const forwarded = [];
  old.sendImplementation = async () => {
    old.emit("session.truncation", { tokenLimit: 272000, messagesRemovedDuringTruncation: 2,
      tokensRemovedDuringTruncation: 50000, performedBy: "PRIVATE_PAYLOAD" });
    old.emit("assistant.message_delta", { deltaContent: "must not return a truncated answer" });
    old.emit("assistant.message", { content: "must not return a truncated answer", toolRequests: [] });
    old.emit("session.idle");
  };
  await manager.start();
  try {
    await assert.rejects(manager.execute(request(), {}, { onEvent: (event) => forwarded.push(event) }),
      (error) => error.name === "BridgeRequestError" && /prompt is too long/.test(error.message));
    assert.deepEqual(forwarded, []);
    assert.equal(old.abortCalls, 1);
    assert.equal(client.deleted.length, 1);
    assert.equal((await manager.execute({ ...request(), messages: [{ role: "user", content: "Compacted retained history" }] }, {})).message.content, "ok");
    assert.notEqual(client.created[0].sessionId, client.created[1].sessionId);
    assert.equal(diagnostics.find((event) => event.event === "bridge.context_limit").tokenLimit, 272000);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_PAYLOAD/);
  } finally { await manager.stop(); }
});

test("subagent truncation does not abort the root session", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: ".", client });
  client.session.sendImplementation = async () => {
    client.session.emit("session.truncation", { tokenLimit: 100, messagesRemovedDuringTruncation: 2,
      tokensRemovedDuringTruncation: 20 }, { agentId: "other-agent" });
    client.session.emit("assistant.message", { content: "root still healthy", toolRequests: [] });
    client.session.emit("session.idle");
  };
  await manager.start();
  try {
    assert.equal((await manager.execute(request(), {})).message.content, "root still healthy");
    assert.equal(client.session.abortCalls, 0);
  } finally { await manager.stop(); }
});

test("SDK compaction between HTTP turns cannot silently hide history from the next request", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const old = client.session;
  const replacement = new FakeSession();
  client.createSessionImplementation = () => client.created.length === 1 ? old : replacement;
  const diagnostics = [];
  const manager = new SessionManager({ baseDirectory: ".", client, onDiagnostic: (e) => diagnostics.push(e) });
  await manager.start();
  try {
    await manager.execute(request(), {});
    old.emit("session.compaction_start", { tokenLimit: 272000, currentTokens: 273000, trigger: "threshold" });
    old.emit("session.compaction_complete", { success: true, tokenLimit: 272000, tokensRemoved: 50000, messagesRemoved: 3 });
    await assert.rejects(manager.execute(request(), {}), /prompt is too long/);
    assert.equal(old.sendCalls.length, 1, "do not send the next prompt into reduced upstream history");
    assert.equal(client.deleted.length, 1);
    assert.equal((await manager.execute(request(), {})).message.content, "ok");
    assert.ok(diagnostics.some((e) => e.event === "bridge.context_limit" && e.phase === "between_requests"));
  } finally { await manager.stop(); }
});

async function settlementWithin(promise, ms = 200) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ value }), (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("times out SDK creation, releases the family queue and discards a late session", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const abandoned = new FakeSession();
  const recovered = new FakeSession();
  let release;
  client.createSessionImplementation = () => client.created.length === 1
    ? new Promise((resolve) => { release = resolve; }) : recovered;
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client,
    sessionOperationTimeoutMs: 20, cleanupTimeoutMs: 10,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  await manager.start();
  const headers = { "x-claude-code-session-id": "creation-deadline" };
  const pending = manager.execute(request(), headers, { requestId: "request-create" });
  try {
    const outcome = await settlementWithin(pending);
    assert.equal(outcome.error?.name, "SessionOperationTimeoutError");
    assert.equal(manager.stateCreations.size, 0);
    assert.equal(manager.states.size, 0);
    assert.equal((await manager.execute(request(), headers)).message.content, "ok");
    assert.notEqual(client.created[0].sessionId, client.created[1].sessionId);
    release(abandoned);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abandoned.abortCalls, 1);
    assert.equal(abandoned.disconnectCalls, 1);
    assert.ok(client.deleted.includes(client.created[0].sessionId));
    assert.equal(recovered.disconnectCalls, 0);
    assert.ok(diagnostics.some((event) => event.operation === "session.create" &&
      event.reason === "timeout" && event.requestId === "request-create"));
  } finally {
    release?.(abandoned);
    await pending.catch(() => {});
    await manager.stop();
  }
});

test("a stalled SDK resume times out without silently starting another session", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const abandoned = client.session;
  let release;
  client.resumeSession = () => new Promise((resolve) => { release = resolve; });
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client,
    sessionOperationTimeoutMs: 20, cleanupTimeoutMs: 10, stateIdleTtlMs: 100,
  });
  const headers = { "x-claude-code-session-id": "resume-deadline" };
  await manager.start();
  let pending;
  try {
    await manager.execute(request(), headers);
    [...manager.states.values()][0].lastUsedAt = 0;
    pending = manager.execute(request(), headers);
    const outcome = await settlementWithin(pending);
    assert.equal(outcome.error?.name, "SessionOperationTimeoutError");
    assert.equal(client.created.length, 1, "timeout must not become a silent fresh-session fallback");
    client.session = new FakeSession();
    await manager.execute({
      ...request(),
      messages: [
        { role: "user", content: "retained history" },
        { role: "assistant", content: "acknowledged" },
        { role: "user", content: "continue" },
      ],
    }, headers);
    assert.match(client.session.sendCalls[0].prompt, /USER: retained history/);
    assert.notEqual(client.created[0].sessionId, client.created[1].sessionId);
    release(abandoned);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(client.deleted.includes(client.created[0].sessionId));
    assert.equal(client.session.disconnectCalls, 0);
  } finally {
    release?.(abandoned);
    await pending?.catch(() => {});
    await manager.stop();
  }
});

test("cancellation during SDK creation settles before a late RPC acknowledgment", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  let release;
  client.createSessionImplementation = () => new Promise((resolve) => { release = resolve; });
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client,
    sessionOperationTimeoutMs: 1000, cleanupTimeoutMs: 10,
  });
  const controller = new AbortController();
  await manager.start();
  const pending = manager.execute(request(), { "x-claude-code-session-id": "cancel-create" }, { signal: controller.signal });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal((await settlementWithin(pending)).error?.name, "AbortError");
    assert.equal(manager.stateCreations.size, 0);
    release(client.session);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.states.size, 0);
    assert.equal(client.session.sendCalls.length, 0);
    assert.equal(client.session.disconnectCalls, 1);
  } finally {
    release?.(client.session);
    await pending.catch(() => {});
    await manager.stop();
  }
});

test("a queued cancellation returns promptly without overtaking the active turn", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  let release;
  client.session.sendImplementation = async () => {
    if (client.session.sendCalls.length === 1) await new Promise((resolve) => { release = resolve; });
    client.session.emit("assistant.message", { content: "ok", toolRequests: [] });
    client.session.emit("session.idle");
  };
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  await manager.start();
  const headers = { "x-claude-code-session-id": "queued-cancellation" };
  const first = manager.execute(request(), headers);
  const controller = new AbortController();
  const cancelled = manager.execute(request(), headers, { signal: controller.signal });
  const next = manager.execute(request(), headers);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal((await settlementWithin(cancelled)).error?.name, "AbortError");
    assert.equal(client.session.sendCalls.length, 1);
    release();
    assert.equal((await first).message.content, "ok");
    assert.equal((await next).message.content, "ok");
    assert.equal(client.session.sendCalls.length, 2);
  } finally {
    release?.();
    await Promise.allSettled([first, cancelled, next]);
    await manager.stop();
  }
});

test("bounds a hung SDK effort change and recovers with a fresh session", async () => {
  const client = new FakeClient([{
    id: "gpt-5.6-sol", supportedReasoningEfforts: ["low", "high"],
    capabilities: { supports: { reasoningEffort: true } },
  }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client,
    sessionOperationTimeoutMs: 20, cleanupTimeoutMs: 10,
  });
  const headers = { "x-claude-code-session-id": "effort-deadline" };
  let release;
  await manager.start();
  try {
    await manager.execute(request("low"), headers);
    const abandoned = client.session;
    abandoned.setModel = () => new Promise((resolve) => { release = resolve; });
    const changed = manager.execute(request("high"), headers);
    const outcome = await settlementWithin(changed);
    release?.();
    await changed.catch(() => {});
    assert.equal(outcome.error?.name, "SessionOperationTimeoutError");
    assert.equal(manager.states.size, 0);
    client.session = new FakeSession();
    assert.equal((await manager.execute(request("low"), headers)).message.content, "ok");
    assert.equal(client.created.length, 2);
    assert.equal(abandoned.disconnectCalls, 1);
  } finally {
    release?.();
    await manager.stop();
  }
});

test("shutdown cancels pending SDK creation instead of waiting indefinitely", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  let release;
  client.createSessionImplementation = () => new Promise((resolve) => { release = resolve; });
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client, cleanupTimeoutMs: 10,
  });
  await manager.start();
  const pending = manager.execute(request(), { "x-claude-code-session-id": "shutdown-create" });
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = manager.stop();
  try {
    const outcome = await settlementWithin(stopped);
    release?.(client.session);
    assert.equal(outcome.pending, undefined);
    assert.equal(outcome.error, undefined);
    await assert.rejects(pending, { name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.states.size, 0);
  } finally {
    release?.(client.session);
    await Promise.allSettled([pending, stopped]);
  }
});

test("a stopped manager can start again without inheriting its shutdown cancellation", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  await manager.start();
  await manager.execute(request(), {});
  await manager.stop();
  await manager.start();
  try {
    assert.equal((await manager.execute(request(), {})).message.content, "ok");
  } finally {
    await manager.stop();
  }
});

test("cold recovery defaults to 256 MiB and preserves an explicit replay limit", async () => {
  const history = "x".repeat(300 * 1024);
  for (const maxReplayBytes of [undefined, 256 * 1024]) {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const diagnostics = [];
    const manager = new SessionManager({
      baseDirectory: "/tmp",
      preferredModel: "gpt-5.6-sol",
      client,
      maxReplayBytes,
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await manager.start();
    try {
      assert.equal(manager.maxReplayBytes, maxReplayBytes ?? 268_435_456);
      await manager.execute({
        ...request(),
        messages: [
          { role: "user", content: history },
          { role: "assistant", content: "retained reply" },
          { role: "user", content: "continue" },
        ],
      }, { "x-claude-code-session-id": "replay-limit" });

      const prompt = client.session.sendCalls[0].prompt;
      const truncated = diagnostics.filter((event) => event.event === "bridge.history_replay_truncated");
      assert.equal(prompt.includes(history), maxReplayBytes === undefined);
      assert.match(prompt, /ASSISTANT: retained reply/);
      assert.equal(prompt.endsWith("continue"), true);
      assert.equal(truncated.length, maxReplayBytes === undefined ? 0 : 1);
      if (truncated.length) assert.equal(truncated[0].maxBytes, maxReplayBytes);
    } finally {
      await manager.stop();
    }
  }
});

test("applies initial and updated Claude Code effort to the Copilot session", async () => {
  const client = new FakeClient([
    {
      id: "gpt-5.6-sol",
      capabilities: {
        supports: { reasoningEffort: true },
        supportedReasoningEfforts: [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
      },
    },
  ]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });

  await manager.start();
  try {
    await manager.execute(request("ultracode"), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0].reasoningEffort, "xhigh");
    assert.deepEqual(client.created[0].toolSearch, {
      enabled: false,
    });

    await manager.execute(request("high"), {
      "x-claude-code-session-id": "session-1",
    });
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(client.created.length, 1);
    assert.deepEqual(client.session.setModelCalls, [
      {
        model: "gpt-5.6-sol",
        options: { reasoningEffort: "high" },
      },
      {
        model: "gpt-5.6-sol",
        options: undefined,
      },
    ]);
  } finally {
    await manager.stop();
  }
});

test("aborts the active Copilot turn when the request signal is cancelled", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 10_000,
    client,
  });

  const controller = new AbortController();
  let releaseAbort;
  client.session.abortImplementation = () =>
    new Promise((resolve) => {
      releaseAbort = resolve;
    });
  client.session.sendImplementation = async () => {
    controller.abort();
  };

  await manager.start();
  try {
    const first = manager.execute(
      request(),
      { "x-claude-code-session-id": "session-1" },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    client.session.sendImplementation = null;
    const second = manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(client.session.sendCalls.length, 1);

    releaseAbort();
    client.session.abortImplementation = null;
    await assert.rejects(
      first,
      { name: "AbortError" },
    );
    assert.equal((await second).message.content, "ok");
    assert.equal(client.session.abortCalls, 1);
  } finally {
    await manager.stop();
  }
});

test("bounds a hung Copilot abort before releasing the session queue", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const oldSession = new FakeSession();
  const replacementSession = new FakeSession();
  const sessions = [oldSession, replacementSession];
  client.createSessionImplementation = async () => sessions.shift();
  const manager = new SessionManager({
    abortTimeoutMs: 20,
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 10_000,
    client,
  });
  const controller = new AbortController();
  oldSession.abortImplementation = () => new Promise(() => {});
  oldSession.sendImplementation = async () => {
    controller.abort();
    setTimeout(() => {
      oldSession.emit("assistant.message", {
        content: "OLD_TURN",
        toolRequests: [],
        outputTokens: 1,
      });
      oldSession.emit("session.idle");
    }, 50);
  };

  await manager.start();
  try {
    await assert.rejects(
      manager.execute(
        request(),
        { "x-claude-code-session-id": "session-1" },
        { signal: controller.signal },
      ),
      { name: "AbortError" },
    );
    const next = await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(next.message.content, "ok");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(client.created.length, 2);
    assert.equal(client.deleted.length, 1);
  } finally {
    oldSession.abortImplementation = null;
    await manager.stop();
  }
});

test("replaces a session when turn timeout abort is not acknowledged", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const oldSession = new FakeSession();
  const replacementSession = new FakeSession();
  const sessions = [oldSession, replacementSession];
  client.createSessionImplementation = async () => sessions.shift();
  oldSession.abortImplementation = () => new Promise(() => {});
  oldSession.disconnectImplementation = () => new Promise(() => {});
  oldSession.sendImplementation = async () => {
    setTimeout(() => {
      oldSession.emit("assistant.message", {
        content: "LATE_FIRST",
        toolRequests: [],
        outputTokens: 1,
      });
      oldSession.emit("session.idle");
    }, 35);
  };
  const manager = new SessionManager({
    abortTimeoutMs: 20,
    baseDirectory: "/tmp",
    cleanupTimeoutMs: 20,
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 20,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await assert.rejects(
      manager.execute(request(), headers),
      /Timed out waiting for the GitHub Copilot model turn/,
    );
    const next = await manager.execute(request(), headers);
    assert.equal(next.message.content, "ok");
    assert.equal(client.created.length, 2);
    assert.equal(client.deleted.length, 1);
    assert.notEqual(
      client.created[0].sessionId,
      client.created[1].sessionId,
    );
  } finally {
    oldSession.abortImplementation = null;
    oldSession.disconnectImplementation = null;
    await manager.stop();
  }
});

for (const acknowledged of [false, true]) {
  test(`turn timeout diagnostics distinguish ${acknowledged ? "model silence" : "an unacknowledged send"}`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const diagnostics = [];
    const manager = new SessionManager({
      baseDirectory: ".",
      client,
      turnTimeoutMs: 20,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    client.session.sendImplementation = () => acknowledged
      ? Promise.resolve()
      : new Promise(() => {});

    await manager.start();
    try {
      await assert.rejects(manager.execute(request(), {}, {
        requestId: "request-timeout",
        responseId: "msg_timeout",
      }), /Timed out waiting for the GitHub Copilot model turn/);
      const [timeout, abort] = diagnostics;
      assert.equal(timeout.event, "bridge.turn_timeout");
      assert.equal(timeout.requestId, "request-timeout");
      assert.equal(timeout.responseId, "msg_timeout");
      assert.match(timeout.state, /^[a-f0-9]{12}$/);
      assert.ok(Number.isFinite(Date.parse(timeout.timestamp)));
      assert.ok(timeout.elapsedMs >= timeout.turnElapsedMs);
      assert.ok(timeout.turnElapsedMs >= 0);
      assert.equal(timeout.stage, acknowledged ? "model" : "send");
      assert.equal(timeout.triggerFinished, acknowledged);
      assert.equal(timeout.turnStarted, false);
      assert.equal(timeout.messages, 0);
      assert.equal(timeout.pendingToolCalls, 0);
      assert.deepEqual(timeout.rpc.send, {
        started: 1, acknowledged: Number(acknowledged), failed: 0,
      });
      assert.equal(abort.event, "bridge.turn_abort_completed");
      assert.equal(abort.reason, "timeout");
      assert.equal(abort.acknowledged, true);
      assert.equal(client.session.abortCalls, 1);
    } finally {
      await manager.stop();
    }
  });
}

test("turn diagnostics bound event history and exclude payloads and identifiers", async () => {
  const secret = "DIAGNOSTIC_SECRET";
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: ".",
    client,
    turnTimeoutMs: 20,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  client.session.sendImplementation = async () => {
    for (let index = 0; index < 32; index += 1) {
      client.session.emit("assistant.message_delta", { deltaContent: secret });
      client.session.emit("assistant.message_delta", { deltaContent: secret }, { agentId: secret });
    }
    client.session.emit("assistant.message", {
      content: secret,
      toolRequests: [{ name: secret, toolCallId: secret, arguments: { secret } }],
    }, { agentId: secret });
    client.session.emit("external_tool.requested", {
      requestId: secret, toolCallId: secret, toolName: secret, arguments: { secret },
    });
  };

  await manager.start();
  try {
    await assert.rejects(manager.execute({
      ...request(),
      system: secret,
      tools: [{ name: secret, description: secret, input_schema: { type: "object" } }],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: secret },
          { type: "image", source: { type: "base64", media_type: "image/png", data: secret } },
        ],
      }],
    }, {
      "x-claude-code-session-id": secret,
      "x-claude-code-agent-id": secret,
      authorization: secret,
    }), /Timed out/);
    const timeout = diagnostics[0];
    assert.equal(timeout.eventCounts["root:assistant.message_delta"], 32);
    assert.equal(timeout.eventCounts["agent:assistant.message_delta"], 32);
    assert.equal(timeout.eventCounts["agent:assistant.message"], 1);
    assert.equal(timeout.eventCounts["root:external_tool.requested"], 1);
    assert.equal(timeout.turnStarted, false);
    assert.equal(timeout.messages, 0);
    assert.equal(timeout.pendingToolCalls, 1);
    assert.equal(timeout.recentEvents.length, 8);
    assert.ok(timeout.recentEvents.every((event) => event.elapsedMs >= 0));
    assert.equal(JSON.stringify(diagnostics).includes(secret), false);
    assert.equal(client.session.handlers.get("assistant.message").size, 0);
    assert.equal(client.session.handlers.get("external_tool.requested").size, 1);
  } finally {
    await manager.stop();
  }
});

test("turn diagnostics distinguish a partial result submission from model silence", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: ".",
    client,
    turnTimeoutMs: 20,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [1, 2, 3].map((id) => ({
        name: "Read", toolCallId: `tool-${id}`, arguments: {},
      })),
    });
    for (const id of [1, 2, 3]) {
      client.session.emit("external_tool.requested", {
        requestId: `request-${id}`, toolCallId: `tool-${id}`, toolName: "Read",
      });
    }
  };
  let releaseResult;
  client.session.handlePendingToolCallImplementation = async ({ requestId }) => {
    if (requestId === "request-3") {
      await new Promise((resolve) => { releaseResult = resolve; });
    }
    client.session.emit("external_tool.completed", { requestId });
    return { success: true };
  };

  await manager.start();
  try {
    await manager.execute(toolBody, headers);
    assert.deepEqual(diagnostics, []);
    await assert.rejects(manager.execute({
      ...toolBody,
      messages: [{
        role: "user",
        content: [1, 2, 3].map((id) => ({
          type: "tool_result", tool_use_id: `tool-${id}`, content: "PRIVATE_TOOL_RESULT",
        })),
      }],
    }, headers, { requestId: "results-request" }), /Timed out/);
    const timeout = diagnostics[0];
    assert.equal(timeout.requestId, "results-request");
    assert.equal(timeout.stage, "tool_result");
    assert.equal(timeout.triggerFinished, false);
    assert.equal(timeout.pendingToolCalls, 1);
    assert.equal(timeout.pendingRegistrations, 0);
    assert.deepEqual(timeout.rpc.send, { started: 0, acknowledged: 0, failed: 0 });
    assert.deepEqual(timeout.rpc.toolResult, { started: 3, acknowledged: 2, failed: 0 });
    assert.equal(timeout.eventCounts["root:external_tool.completed"], 2);
    assert.equal(client.session.handledToolCalls.length, 3);
    assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_TOOL_RESULT"), false);
    releaseResult();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timeout.rpc.toolResult.acknowledged, 2);
  } finally {
    releaseResult?.();
    await manager.stop();
  }
});

test("turn diagnostics identify a pending tool registration", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: ".",
    client,
    turnTimeoutMs: 20,
    pendingToolWaitMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "PRIVATE_MODEL_OUTPUT",
      toolRequests: [{ name: "Read", toolCallId: "private-call", arguments: {} }],
    });
  };
  await manager.start();
  try {
    await assert.rejects(manager.execute({
      ...request(),
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    }, {}), /Timed out/);
    const timeout = diagnostics[0];
    assert.equal(timeout.stage, "tool_registration");
    assert.equal(timeout.triggerFinished, true);
    assert.equal(timeout.completionStarted, true);
    assert.equal(timeout.messages, 1);
    assert.equal(timeout.toolRequests, 1);
    assert.equal(timeout.pendingRegistrations, 1);
    assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_MODEL_OUTPUT"), false);
    assert.equal(JSON.stringify(diagnostics).includes("private-call"), false);
  } finally {
    await manager.stop();
  }
});

for (const acknowledged of [false, true]) {
  test(`client abort diagnostics preserve deferred completion and report abort acknowledgment ${acknowledged}`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const diagnostics = [];
    const controller = new AbortController();
    const manager = new SessionManager({
      baseDirectory: ".",
      client,
      turnTimeoutMs: 1000,
      abortTimeoutMs: 20,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    let releaseSend;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    client.session.sendImplementation = async () => {
      client.session.emit("assistant.turn_start");
      client.session.emit("assistant.message", { content: "PRIVATE_OUTPUT", toolRequests: [] });
      client.session.emit("assistant.turn_end");
      ready();
      await new Promise((resolve) => { releaseSend = resolve; });
    };
    if (!acknowledged) client.session.abortImplementation = () => new Promise(() => {});
    await manager.start();
    try {
      const rejected = assert.rejects(manager.execute(request(), {}, {
        requestId: "aborted-request",
        signal: controller.signal,
      }), { name: "AbortError" });
      await started;
      controller.abort(new Error("PRIVATE_ABORT_REASON"));
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].event, "bridge.turn_aborted");
      assert.equal(diagnostics[0].requestId, "aborted-request");
      assert.equal(diagnostics[0].stage, "send");
      assert.equal(diagnostics[0].deferredCompletion, true);
      assert.equal(diagnostics[0].turnStarted, true);
      assert.equal(diagnostics[0].eventCounts["root:assistant.turn_end"], 1);
      await rejected;
      assert.equal(diagnostics[1].event, "bridge.turn_abort_completed");
      assert.equal(diagnostics[1].reason, "client_abort");
      assert.equal(diagnostics[1].acknowledged, acknowledged);
      assert.ok(diagnostics[1].abortElapsedMs >= 0);
      assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_"), false);
    } finally {
      releaseSend?.();
      client.session.abortImplementation = null;
      await manager.stop();
    }
  });
}

for (const asynchronous of [false, true]) {
  test(`turn diagnostic ${asynchronous ? "rejections" : "exceptions"} are logged without changing the timeout`, async (t) => {
    const logged = [];
    t.mock.method(console, "error", (line) => logged.push(JSON.parse(line)));
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const fail = () => { throw new Error("PRIVATE_DIAGNOSTIC_ERROR"); };
    const manager = new SessionManager({
      baseDirectory: ".",
      client,
      turnTimeoutMs: 20,
      onDiagnostic: asynchronous ? async () => fail() : fail,
    });
    client.session.sendImplementation = async () => {};
    await manager.start();
    try {
      await assert.rejects(manager.execute(request(), {}, {
        requestId: "failed-diagnostic-request",
      }), /Timed out waiting for the GitHub Copilot model turn/);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(logged.length, 2);
      assert.ok(logged.every((event) => event.event === "bridge.diagnostic_error"));
      assert.ok(logged.every((event) => event.requestId === "failed-diagnostic-request"));
      assert.deepEqual(logged.map((event) => event.diagnosticEvent), [
        "bridge.turn_timeout", "bridge.turn_abort_completed",
      ]);
      assert.equal(JSON.stringify(logged).includes("PRIVATE_DIAGNOSTIC_ERROR"), false);
      assert.equal(client.session.abortCalls, 1);
    } finally {
      await manager.stop();
    }
  });
}

test("successful turns do not emit turn diagnostics", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: ".",
    client,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  await manager.start();
  try {
    assert.equal((await manager.execute(request(), {})).message.content, "ok");
    assert.deepEqual(diagnostics, []);
  } finally {
    await manager.stop();
  }
});

for (const [label, usageEvents, inputTokens, outputTokens] of [
  ["returns null without usage events", [], undefined, undefined],
  ["preserves explicit input zero", [{ inputTokens: 0, outputTokens: 7 }], 0, 7],
  ["preserves explicit output zero", [{ inputTokens: 12, outputTokens: 0 }], 12, 0],
  ["preserves omitted input", [{ outputTokens: 7 }], undefined, 7],
  ["preserves omitted output", [{ inputTokens: 12 }], 12, undefined],
  ["preserves both missing counters", [{}], undefined, undefined],
  ["treats null counters as missing", [{ inputTokens: null, outputTokens: null }], undefined, undefined],
  ["sums complete counters", [{ inputTokens: 12, outputTokens: 3 }, { inputTokens: 8, outputTokens: 5 }], 20, 8],
  ["sums explicit zero counters", [{ inputTokens: 0, outputTokens: 0 }, { inputTokens: 0, outputTokens: 0 }], 0, 0],
  ["does not hide missing earlier input", [{ outputTokens: 3 }, { inputTokens: 8, outputTokens: 5 }], undefined, 8],
  ["does not hide missing later input", [{ inputTokens: 12, outputTokens: 3 }, { outputTokens: 5 }], undefined, 8],
  ["does not hide missing earlier output", [{ inputTokens: 12 }, { inputTokens: 8, outputTokens: 5 }], 20, undefined],
  ["does not hide missing later output", [{ inputTokens: 12, outputTokens: 3 }, { inputTokens: 8 }], 20, undefined],
]) {
  test(`usage collection ${label} through JSON and SSE`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const manager = new SessionManager({ baseDirectory: ".", client });
    client.session.sendImplementation = async () => {
      for (const usage of usageEvents) client.session.emit("assistant.usage", usage);
      client.session.emit("assistant.message", {
        content: "done", toolRequests: [], outputTokens: 99,
      });
      client.session.emit("session.idle");
    };
    await manager.start();
    try {
      const result = await manager.execute(request(), {});
      assert.deepEqual(result.usage, usageEvents.length === 0 ? null : {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contentFilterTriggered: false,
        finishReason: null,
        inputTokens,
        outputTokens,
        reasoningTokens: 0,
      });
      const expected = { input_tokens: inputTokens ?? 321, output_tokens: outputTokens ?? 99 };
      const json = fakeResponse();
      writeJsonMessage(json, { id: "msg_usage", inputTokens: 321, ...result });
      assert.deepEqual(JSON.parse(json.chunks.join("")).usage, expected);
      const sse = fakeResponse();
      startSse(sse);
      new AnthropicSseStream(sse, { id: "msg_usage", inputTokens: 321 }).finish(result);
      const events = sseEvents(sse);
      assert.equal(events.find((event) => event.type === "message_start").message.usage.input_tokens, 321);
      assert.deepEqual(events.find((event) => event.type === "message_delta").usage, expected);
    } finally {
      await manager.stop();
    }
  });
}

test("cache-only usage preserves fallback counters and finish metadata", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: ".", client });
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.usage", { inputTokens: 10, cacheReadTokens: 3, outputTokens: 5 });
    client.session.emit("assistant.usage", { cacheWriteTokens: 4, reasoningTokens: 2, finishReason: "length" });
    client.session.emit("assistant.message", { content: "done", toolRequests: [], outputTokens: 99 });
    client.session.emit("session.idle");
  };
  await manager.start();
  try {
    const result = await manager.execute(request(), {});
    assert.deepEqual(result.usage, {
      cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 2,
      inputTokens: undefined, outputTokens: undefined,
      contentFilterTriggered: false, finishReason: "length",
    });
    const json = fakeResponse();
    writeJsonMessage(json, { id: "msg_cache", inputTokens: 321, ...result });
    const body = JSON.parse(json.chunks.join(""));
    assert.deepEqual(body.usage, {
      input_tokens: 321, output_tokens: 99,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    });
    assert.equal(body.stop_reason, "max_tokens");
    const sse = fakeResponse();
    startSse(sse);
    new AnthropicSseStream(sse, { id: "msg_cache", inputTokens: 321 }).finish(result);
    const delta = sseEvents(sse).find((event) => event.type === "message_delta");
    assert.deepEqual(delta.usage, body.usage);
    assert.equal(delta.delta.stop_reason, "max_tokens");
  } finally {
    await manager.stop();
  }
});

test("returns actual SDK usage when an assistant usage event is available", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.usage", {
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      finishReason: "length",
      inputTokens: 100,
      model: "gpt-5.6-sol",
      outputTokens: 20,
      reasoningTokens: 5,
    });
    client.session.emit("assistant.message", {
      content: "done",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.deepEqual(result.usage, {
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      contentFilterTriggered: false,
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
    });
  } finally {
    await manager.stop();
  }
});

test("reports state splits without logging system prompt contents", async () => {
  const diagnostics = [];
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await manager.execute(request(), headers);
    await manager.execute(
      { ...request(), system: "changed secret system prompt" },
      headers,
    );

    assert.equal(diagnostics[0].event, "bridge.state_split");
    assert.deepEqual(diagnostics[0].changes, ["systemHash"]);
    assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  } finally {
    await manager.stop();
  }
});

test("evicts the least-recent idle state when the state limit is exceeded", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    client,
  });

  await manager.start();
  try {
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    await Promise.resolve();
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });

    assert.equal(client.session.disconnectCalls, 1);
  } finally {
    await manager.stop();
  }
});

test("does not evict a state with a pending external tool call", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const pendingSession = new FakeSession();
  const idleSession = new FakeSession();
  const sessions = [pendingSession, idleSession];
  client.createSessionImplementation = async () => sessions.shift();
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    client,
  });
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  pendingSession.sendImplementation = async () => {
    pendingSession.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: {} },
      ],
      outputTokens: 1,
    });
    pendingSession.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
  };

  await manager.start();
  try {
    await manager.execute(toolBody, {
      "x-claude-code-session-id": "session-1",
    });
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });
    assert.equal(pendingSession.disconnectCalls, 0);
    assert.equal(idleSession.disconnectCalls, 1);
  } finally {
    await manager.stop();
  }
});

test("shares one state creation across concurrent requests", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  let releaseCreation;
  client.createSessionImplementation = async () => {
    await new Promise((resolve) => {
      releaseCreation = resolve;
    });
    return client.session;
  };
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    const first = manager.execute(request(), headers);
    const second = manager.execute(request(), headers);
    await new Promise((resolve) => setImmediate(resolve));
    releaseCreation();
    await Promise.all([first, second]);
    assert.equal(client.created.length, 1);
  } finally {
    await manager.stop();
  }
});

test("does not evict newly created states before their first concurrent turns", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const sessions = [];
  let releaseTurns;
  let startedTurns = 0;
  const turnBarrier = new Promise((resolve) => {
    releaseTurns = resolve;
  });
  client.createSessionImplementation = async () => {
    const session = new FakeSession();
    session.sendImplementation = async () => {
      startedTurns += 1;
      if (startedTurns === 2) releaseTurns();
      await turnBarrier;
      if (session.disconnectCalls) {
        throw new Error("send-after-disconnect");
      }
      session.emit("assistant.message", {
        content: "ok",
        toolRequests: [],
        outputTokens: 1,
      });
      session.emit("session.idle");
    };
    sessions.push(session);
    return session;
  };
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    client,
  });

  await manager.start();
  try {
    const responses = await Promise.all([
      manager.execute(request(), {
        "x-claude-code-session-id": "session-1",
      }),
      manager.execute(request(), {
        "x-claude-code-session-id": "session-2",
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.message.content),
      ["ok", "ok"],
    );
    assert.equal(
      sessions.filter((session) => session.disconnectCalls > 0).length,
      1,
    );
  } finally {
    await manager.stop();
  }
});

test("waits for state eviction before recreating the same key", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const sessions = [];
  let releaseDisconnect;
  client.createSessionImplementation = async () => {
    const session = new FakeSession();
    sessions.push(session);
    if (sessions.length === 1) {
      session.disconnectImplementation = () =>
        new Promise((resolve) => {
          releaseDisconnect = resolve;
        });
    }
    return session;
  };
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    client,
  });

  await manager.start();
  try {
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    const secondFamily = manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });
    while (sessions[0].disconnectCalls === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const recreated = manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessions.length, 2);

    releaseDisconnect();
    const responses = await Promise.all([secondFamily, recreated]);
    assert.deepEqual(
      responses.map((response) => response.message.content),
      ["ok", "ok"],
    );
    assert.equal(sessions.length, 3);
  } finally {
    for (const session of sessions) {
      session.disconnectImplementation = null;
    }
    await manager.stop();
  }
});

test("does not reuse anonymous Copilot sessions across bridge instances", async () => {
  const firstClient = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const secondClient = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const firstManager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client: firstClient,
  });

  test("does not reuse named Copilot sessions across bridge instances", async () => {
    const firstClient = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const secondClient = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const firstManager = new SessionManager({
      baseDirectory: "/tmp",
      preferredModel: "gpt-5.6-sol",
      client: firstClient,
    });
    const secondManager = new SessionManager({
      baseDirectory: "/tmp",
      preferredModel: "gpt-5.6-sol",
      client: secondClient,
    });
    const headers = { "x-claude-code-session-id": "session-1" };

    await firstManager.start();
    await secondManager.start();
    try {
      await firstManager.execute(request(), headers);
      await secondManager.execute(request(), headers);
      assert.notEqual(
        firstClient.created[0].sessionId,
        secondClient.created[0].sessionId,
      );
    } finally {
      await firstManager.stop();
      await secondManager.stop();
    }
  });
  const secondManager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client: secondClient,
  });

  await firstManager.start();
  await secondManager.start();
  try {
    await firstManager.execute(request(), {});
    await secondManager.execute(request(), {});
    assert.notEqual(
      firstClient.created[0].sessionId,
      secondClient.created[0].sessionId,
    );
  } finally {
    await firstManager.stop();
    await secondManager.stop();
  }
});

for (const change of ["model", "tools", "system"]) {
  test(`replays intervening turns after ${change} switches A to B to A`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }]);
    const sessions = [];
    client.createSessionImplementation = async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    };
    const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
    const headers = { "x-claude-code-session-id": `switch-${change}` };
    const a = request();
    const b = {
      ...a,
      ...(change === "model" ? { model: "gpt-5.6-terra" } : {}),
      ...(change === "system" ? { system: "different instructions" } : {}),
      ...(change === "tools" ? { tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }] } : {}),
      messages: [...a.messages, { role: "assistant", content: "ok" },
        { role: "user", content: "Only in B: deployment target is ORCHID." }],
    };
    await manager.start();
    try {
      await manager.execute(a, headers);
      await manager.execute(b, headers);
      const back = { ...a, messages: [...b.messages, { role: "assistant", content: "noted" },
        { role: "user", content: "What is the deployment target?" }] };
      await manager.execute(back, headers);
      assert.equal(sessions.length, 3);
      assert.match(sessions[2].sendCalls[0].prompt, /Only in B: deployment target is ORCHID/);
      assert.equal(sessions[0].disconnectCalls, 1);
      await manager.execute({ ...back, messages: [...back.messages,
        { role: "assistant", content: "ORCHID" }, { role: "user", content: "continue normally" }] }, headers);
      assert.equal(sessions.length, 3);
      assert.equal(sessions[2].sendCalls[1].prompt, "continue normally");
    } finally {
      await manager.stop();
    }
  });
}

test("recreates Copilot state when same-length Claude history diverges", async () => {
  const diagnostics = [];
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await manager.execute(
      {
        ...request(),
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
      },
      headers,
    );
    await manager.execute(
      {
        ...request(),
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "replacement" },
          { role: "user", content: "rewound" },
        ],
      },
      headers,
    );

    assert.equal(client.created.length, 2);
    assert.equal(client.deleted.length, 1);
    assert.equal(
      diagnostics.some(
        (event) => event.event === "bridge.history_reconciled",
      ),
      true,
    );
  } finally {
    await manager.stop();
  }
});

test("retains pending tool calls when Claude moves transient system annotations", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const sessions = [];
  const diagnostics = [];
  client.createSessionImplementation = async () => {
    const session = new FakeSession();
    sessions.push(session);
    session.sendImplementation = async () => {
      session.emit("assistant.message", {
        content: "",
        toolRequests: [{ toolCallId: "read-1", name: "Read", arguments: { file_path: "/tmp/input" } }],
      });
      session.emit("external_tool.requested", {
        requestId: "pending-1", toolCallId: "read-1", toolName: "Read",
      });
      session.emit("session.idle");
    };
    session.handlePendingToolCallImplementation = async () => {
      session.emit("assistant.message", { content: "completed", toolRequests: [] });
      session.emit("session.idle");
      return { success: true };
    };
    return session;
  };
  const manager = new SessionManager({
    baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const headers = { "x-claude-code-session-id": "annotated-session" };
  const body = {
    ...request(),
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
  };
  const user = { role: "user", content: "Read the input." };
  await manager.start();
  try {
    await manager.execute({
      ...body,
      messages: [user, { role: "system", content: transientBudget(1000) }],
    }, headers);
    const result = await manager.execute({
      ...body,
      messages: [
        { role: "system", content: transientBudget(900) },
        user,
        { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/input" } }] },
        { role: "system", content: transientBudget(800) },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "actual input" }] },
        { role: "system", content: transientBudget(700) },
      ],
    }, headers);
    assert.equal(client.created.length, 1);
    assert.equal(sessions[0].handledToolCalls.length, 1);
    assert.equal(sessions[0].handledToolCalls[0].requestId, "pending-1");
    assert.equal(sessions[0].sendCalls.length, 1);
    assert.equal(result.message.content, "completed");
    assert.ok(!diagnostics.some((event) => event.event === "bridge.history_reconciled"));
  } finally {
    await manager.stop();
  }
});

test("retains user turns when transient system annotations are inserted or replaced", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  const headers = { "x-claude-code-session-id": "annotated-chat" };
  const user = { role: "user", content: "First user turn." };
  await manager.start();
  try {
    await manager.execute({
      ...request(),
      messages: [user, { role: "system", content: transientBudget(1000) }],
    }, headers);
    await manager.execute({
      ...request(),
      messages: [
        user, { role: "system", content: transientBudget(900) },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Second user turn." },
        { role: "system", content: transientBudget(800) },
      ],
    }, headers);
    assert.equal(client.created.length, 1);
    assert.equal(client.session.sendCalls[1].prompt, "Second user turn.");
  } finally {
    await manager.stop();
  }
});

test("applies meaningful native inline system changes instead of dropping them as telemetry", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  const headers = { "x-claude-code-session-id": "inline-instructions" };
  await manager.start();
  try {
    await manager.execute({
      ...request(),
      messages: [...request().messages, { role: "system", content: "Available custom agents: worker, auditor." }],
    }, headers);
    assert.match(client.created[0].systemMessage.content, /Available custom agents: worker, auditor/);
    await manager.execute({
      ...request(),
      messages: [...request().messages, { role: "system", content: "Available custom agents: worker, auditor.\nOutput style: concise." }],
    }, headers);
    assert.equal(client.created.length, 2);
    assert.match(client.created[1].systemMessage.content, /Output style: concise/);
  } finally {
    await manager.stop();
  }
});

test("does not restart when native cache-control markers move between content blocks", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  const headers = { "x-claude-code-session-id": "cache-markers" };
  await manager.start();
  try {
    await manager.execute({
      ...request(), messages: [{ role: "user", content: [
        { type: "text", text: "first", cache_control: { type: "ephemeral" } },
      ] }],
    }, headers);
    await manager.execute({
      ...request(), messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
      ],
    }, headers);
    assert.equal(client.created.length, 1);
    assert.equal(client.session.sendCalls[1].prompt, "next");
  } finally {
    await manager.stop();
  }
});

test("cache normalization does not hide edits to tool input data named cache_control", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
  const headers = { "x-claude-code-session-id": "cache-input-data" };
  const history = (value) => [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "id-1", name: "custom",
      input: { cache_control: value } }] },
    { role: "user", content: "continue" },
  ];
  await manager.start();
  try {
    await manager.execute({ ...request(), messages: history("first") }, headers);
    await manager.execute({ ...request(), messages: history("changed") }, headers);
    assert.equal(client.created.length, 2);
  } finally {
    await manager.stop();
  }
});
test("applies a supported effort independently for each model", async () => {
  const client = new FakeClient([
    {
      id: "gpt-5-mini",
      capabilities: {
        supports: { reasoningEffort: true },
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    },
    {
      id: "claude-haiku-4.5",
      capabilities: {
        supports: { reasoningEffort: false },
        supportedReasoningEfforts: [],
      },
    },
  ]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5-mini",
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await manager.execute(request("xhigh", "gpt-5-mini"), headers);
    await manager.execute(request("high", "claude-haiku-4.5"), headers);

    assert.equal(client.created[0].reasoningEffort, "high");
    assert.equal("reasoningEffort" in client.created[1], false);
  } finally {
    await manager.stop();
  }
});

test("uses a separate Copilot session when the system prompt changes", async () => {
  const client = new FakeClient([
    {
      id: "gpt-5.6-sol",
      capabilities: {
        supports: { reasoningEffort: true },
        supportedReasoningEfforts: ["high"],
      },
    },
  ]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await manager.execute(request("high"), headers);
    await manager.execute(
      { ...request("high"), system: "different system prompt" },
      headers,
    );

    assert.equal(client.created.length, 2);
    assert.equal(
      client.created[1].systemMessage.content,
      "different system prompt",
    );
  } finally {
    await manager.stop();
  }
});

test("uses separate Copilot sessions for the root and each subagent", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const rootHeaders = { "x-claude-code-session-id": "session-1" };

  await manager.start();
  try {
    await manager.execute(request(), rootHeaders);
    await manager.execute(request(), {
      ...rootHeaders,
      "x-claude-code-agent-id": "agent-1",
    });

    assert.equal(client.created.length, 2);
    assert.notEqual(client.created[0].sessionId, client.created[1].sessionId);
  } finally {
    await manager.stop();
  }
});

test("starts from a user prompt before trailing Claude Code system messages", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const body = {
    ...request(),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "system",
        content: "Prompt metadata.",
      },
    ],
  };

  await manager.start();
  try {
    await manager.execute(body, {
      "x-claude-code-session-id": "session-1",
    });

    assert.equal(client.session.sendCalls.length, 1);
    assert.equal(client.session.sendCalls[0].prompt, "hello");
  } finally {
    await manager.stop();
  }
});

test("starts a forked agent from history ending in an assistant message", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const body = {
    ...request(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "parent-agent", name: "Agent", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "parent-agent",
            content: "Agent started.",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Waiting for the agent." }],
      },
    ],
  };

  await manager.start();
  try {
    await manager.execute(body, {
      "x-claude-code-session-id": "session-1",
      "x-claude-code-agent-id": "agent-1",
    });

    assert.equal(client.session.handledToolCalls.length, 0);
    assert.equal(client.session.sendCalls.length, 1);
    assert.match(client.session.sendCalls[0].prompt, /tool_result parent-agent/);
    assert.match(
      client.session.sendCalls[0].prompt,
      /Continue from the prior conversation/,
    );
  } finally {
    await manager.stop();
  }
});

test("recovers a fresh session from an inherited final tool result", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const body = {
    ...request(),
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "parent-agent", name: "Agent", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "parent-agent",
            content: "Agent started.",
          },
        ],
      },
    ],
  };

  await manager.start();
  try {
    await manager.execute(body, {
      "x-claude-code-session-id": "session-1",
      "x-claude-code-agent-id": "agent-1",
    });

    assert.equal(client.session.handledToolCalls.length, 0);
    assert.equal(client.session.sendCalls.length, 1);
    assert.match(client.session.sendCalls[0].prompt, /tool_result parent-agent/);
  } finally {
    await manager.stop();
  }
});

for (const finalPrompt of [false, true]) {
  test(`cold replay preserves tool-result binary bytes${finalPrompt ? " before a new prompt" : " at the end"}`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", client });
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAwQ=" } };
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } };
    const messages = [
      { role: "user", content: "Read both attachments." },
      { role: "assistant", content: [
        { type: "tool_use", id: "read-png", name: "Read", input: {} },
        { type: "tool_use", id: "read-pdf", name: "Read", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "read-png", content: [image] },
        { type: "tool_result", tool_use_id: "read-pdf", content: [pdf] },
      ] },
      ...(finalPrompt ? [{ role: "assistant", content: "noted" },
        { role: "user", content: [{ type: "text", text: "Compare the attachments." }, image] }] : []),
    ];
    await manager.start();
    try {
      await manager.execute({ ...request(), messages }, {
        "x-claude-code-session-id": "binary-parent", "x-claude-code-agent-id": "forked-child",
      });
      const sent = client.session.sendCalls[0];
      assert.deepEqual(sent.attachments.map(({ data, mimeType }) => ({ data, mimeType })), [
        { data: image.source.data, mimeType: "image/png" },
        { data: pdf.source.data, mimeType: "application/pdf" },
        ...(finalPrompt ? [{ data: image.source.data, mimeType: "image/png" }] : []),
      ]);
      for (const attachment of sent.attachments.slice(0, 2)) {
        assert.ok(sent.prompt.includes(attachment.displayName));
      }
      assert.match(sent.prompt, /tool_result read-png/);
      assert.match(sent.prompt, /tool_result read-pdf/);
    } finally {
      await manager.stop();
    }
  });
}

test("sibling user instructions steer pending tool results exactly once", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", turnTimeoutMs: 500, client });
  const headers = { "x-claude-code-session-id": "tool-steering" };
  const body = { ...request(), tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }] };
  const order = [];
  client.session.sendImplementation = async ({ prompt, mode }) => {
    if (mode === "enqueue") {
      order.push(`user:${prompt}`);
      return;
    }
    client.session.emit("assistant.message", { content: "", toolRequests: [
      { toolCallId: "read-1", name: "Read", arguments: {} },
      { toolCallId: "read-2", name: "Read", arguments: {} },
    ] });
    for (const id of ["read-1", "read-2"]) {
      client.session.emit("external_tool.requested", { requestId: id, toolCallId: id, toolName: "Read" });
    }
  };
  client.session.handlePendingToolCallImplementation = async ({ requestId }) => {
    order.push(`tool:${requestId}`);
    if (requestId === "read-2") {
      client.session.emit("assistant.message", { content: order.some((item) => item.startsWith("user:")) ? "destination B" : "destination A", toolRequests: [] });
      client.session.emit("session.idle");
    }
  };
  const results = { ...body, messages: [{ role: "user", content: [
    { type: "tool_result", tool_use_id: "read-1", content: "one" },
    { type: "tool_result", tool_use_id: "read-2", content: "two" },
    { type: "text", text: "Use this result but change the destination to B." },
  ] }] };
  await manager.start();
  try {
    await manager.execute(body, headers);
    const result = await manager.execute(results, headers);
    assert.equal(result.message.content, "destination B");
    assert.deepEqual(order, ["user:Use this result but change the destination to B.", "tool:read-1", "tool:read-2"]);
    const retry = await manager.execute(results, headers);
    assert.equal(retry.message.content, "destination B");
    assert.equal(client.session.sendCalls.length, 2);
    assert.equal(client.session.handledToolCalls.length, 2);
    assert.deepEqual(client.session.handledToolCalls.map((call) => call.result.textResultForLlm), ["one", "two"]);
  } finally {
    await manager.stop();
  }
});

test("returns a live tool result to its pending Copilot request", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  let pendingRequested = false;

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
    await new Promise((resolve) => setTimeout(resolve, 5));
    pendingRequested = true;
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    }, { agentId: "copilot-agent-1" });
  };
  client.session.handlePendingToolCallImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "done",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    await manager.execute(toolBody, headers);
    assert.equal(pendingRequested, true);
    const result = await manager.execute(
      {
        ...toolBody,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "file" },
            ],
          },
          {
            role: "system",
            content: transientBudget(1000),
          },
        ],
      },
      headers,
    );

    assert.equal(client.session.handledToolCalls.length, 1);
    assert.equal(client.session.handledToolCalls[0].requestId, "request-1");
    assert.equal(result.message.content, "done");

    const retry = await manager.execute(
      {
        ...toolBody,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "file" },
            ],
          },
          {
            role: "system",
            content: transientBudget(1000),
          },
        ],
      },
      headers,
    );
    assert.equal(retry.message.content, "done");
    assert.equal(client.session.handledToolCalls.length, 1);
    assert.equal(client.session.sendCalls.length, 1);
  } finally {
    await manager.stop();
  }
});

test("returns a single-message tool request without an idle event", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 100,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
  };

  await manager.start();
  try {
    const result = await manager.execute(toolBody, headers);
    assert.deepEqual(
      result.message.toolRequests.map((tool) => tool.toolCallId),
      ["tool-1"],
    );
    assert.equal(client.created[0].tools[0].defer, "never");
  } finally {
    await manager.stop();
  }
});

test("preloads MCP tools through the safe full-schema fallback", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    client,
  });
  const body = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "mcp__e2e__echo",
        description: "Echo",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  await manager.start();
  try {
    await manager.execute(body, {
      "x-claude-code-session-id": "session-1",
    });
    assert.deepEqual(
      client.created[0].tools.map(({ defer, name }) => ({ defer, name })),
      [
        { defer: "never", name: "Read" },
        { defer: "never", name: "mcp__e2e__echo" },
      ],
    );
  } finally {
    await manager.stop();
  }
});

test("finishes a resumed tool turn on assistant.turn_end without session.idle", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 100,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.turn_start", { turnId: "turn-1" });
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
    client.session.emit("assistant.turn_end", { turnId: "turn-1" });
  };
  client.session.handlePendingToolCallImplementation = async () => {
    client.session.emit("assistant.turn_start", { turnId: "turn-2" });
    client.session.emit("assistant.message", {
      content: "done",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("assistant.turn_end", { turnId: "turn-2" });
    return { success: true };
  };

  await manager.start();
  try {
    await manager.execute(toolBody, headers);
    const result = await manager.execute(
      {
        ...toolBody,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "file" },
            ],
          },
        ],
      },
      headers,
    );

    assert.equal(result.message.content, "done");
  } finally {
    await manager.stop();
  }
});

test("combines text messages until the turn ends", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 100,
    client,
  });

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.turn_start", { turnId: "turn-1" });
    client.session.emit("assistant.message", {
      content: "first",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("assistant.message", {
      content: "second",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("assistant.turn_end", { turnId: "turn-1" });
  };

  await manager.start();
  try {
    const result = await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(result.message.content, "firstsecond");
  } finally {
    await manager.stop();
  }
});

test("combines tool requests from every message in a completed turn", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 100,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.turn_start", { turnId: "turn-1" });
    client.session.emit("assistant.message", {
      content: "",
      chunkIndex: 0,
      chunkCount: 2,
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("assistant.message", {
      content: "",
      chunkIndex: 1,
      chunkCount: 2,
      toolRequests: [
        { toolCallId: "tool-2", name: "Read", arguments: { file_path: "/tmp/b" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-2",
      toolCallId: "tool-2",
      toolName: "Read",
    });
    client.session.emit("assistant.turn_end", { turnId: "turn-1" });
  };

  await manager.start();
  try {
    const result = await manager.execute(toolBody, headers);

    assert.deepEqual(
      result.message.toolRequests.map((tool) => tool.toolCallId),
      ["tool-1", "tool-2"],
    );
  } finally {
    await manager.stop();
  }
});

test("continues a completed background tool when its final result arrives later", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-luna" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-luna",
    turnTimeoutMs: 100,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(undefined, "gpt-5.6-luna"),
    tools: [
      {
        name: "Agent",
        description: "Start a background agent",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  let handledResults = 0;

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "agent-1", name: "Agent", arguments: {} },
        { toolCallId: "read-1", name: "Read", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "agent-1",
      toolName: "Agent",
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-2",
      toolCallId: "read-1",
      toolName: "Read",
    });
  };
  client.session.handlePendingToolCallImplementation = async () => {
    handledResults += 1;
    if (handledResults < 2) return { success: true };
    client.session.emit("assistant.turn_start", { turnId: "turn-2" });
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("assistant.turn_end", { turnId: "turn-2" });
    return { success: true };
  };

  await manager.start();
  try {
    await manager.execute(toolBody, headers);
    const started = await manager.execute(
      {
        ...toolBody,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "agent-1",
                content: "Agent started.",
              },
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: "file contents",
              },
            ],
          },
        ],
      },
      headers,
    );
    assert.equal(
      started.message.content,
      "Waiting for the background tool to finish.",
    );

    client.session.sendImplementation = async () => {
      client.session.emit("assistant.turn_start", { turnId: "turn-3" });
      client.session.emit("assistant.message", {
        content: "final",
        toolRequests: [],
        outputTokens: 1,
      });
      client.session.emit("assistant.turn_end", { turnId: "turn-3" });
    };
    const completed = await manager.execute(
      {
        ...toolBody,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "agent-1",
                content: "final result",
              },
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: "file contents",
              },
              {
                type: "text",
                text: "The background agent completed.",
              },
            ],
          },
          {
            role: "system",
            content: "Agent status updated.",
          },
        ],
      },
      headers,
    );

    assert.equal(client.session.handledToolCalls.length, 2);
    assert.equal(client.session.sendCalls.length, 2);
    assert.match(client.session.sendCalls[1].prompt, /final result/);
    assert.match(
      client.session.sendCalls[1].prompt,
      /background agent completed/,
    );
    assert.equal(completed.message.content, "final");
  } finally {
    await manager.stop();
  }
});

for (const siblingKind of ["text", "image", "text and image"]) {
  test(`background result updates deliver sibling ${siblingKind} only once`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const manager = new SessionManager({ baseDirectory: "/tmp", preferredModel: "gpt-5.6-sol", turnTimeoutMs: 500, client });
    const headers = { "x-claude-code-session-id": "agent-steering" };
    const body = { ...request(), tools: [{ name: "Agent", input_schema: { type: "object", properties: {} } }] };
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAwQ=" } };
    const results = (content, instruction = "Change the destination to B.", attachment = image) => ({
      ...body,
      messages: [{ role: "user", content: [
        { type: "tool_result", tool_use_id: "agent-1", content },
        ...(siblingKind.includes("text") ? [{ type: "text", text: instruction }] : []),
        ...(siblingKind.includes("image") ? [attachment] : []),
      ] }],
    });
    client.session.sendImplementation = async ({ mode }) => {
      if (mode === "enqueue") return;
      if (client.session.sendCalls.length === 1) {
        client.session.emit("assistant.message", { content: "", toolRequests: [
          { toolCallId: "agent-1", name: "Agent", arguments: {} },
        ] });
        client.session.emit("external_tool.requested", { requestId: "request-1", toolCallId: "agent-1", toolName: "Agent" });
      } else {
        client.session.emit("assistant.message", { content: "updated", toolRequests: [] });
        client.session.emit("session.idle");
      }
    };
    client.session.handlePendingToolCallImplementation = async () => {
      client.session.emit("assistant.message", { content: "started", toolRequests: [] });
      client.session.emit("session.idle");
    };
    await manager.start();
    try {
      await manager.execute(body, headers);
      await manager.execute(results("Agent started."), headers);
      assert.equal(client.session.sendCalls[1].mode, "enqueue");
      if (siblingKind.includes("text")) assert.equal(client.session.sendCalls[1].prompt, "Change the destination to B.");
      if (siblingKind.includes("image")) assert.equal(client.session.sendCalls[1].attachments[0].data, image.source.data);

      const finished = results("Agent finished.");
      await manager.execute(finished, headers);
      assert.match(client.session.sendCalls[2].prompt, /Agent finished\./);
      assert.doesNotMatch(client.session.sendCalls[2].prompt, /Change the destination to B\./);
      assert.deepEqual(client.session.sendCalls[2].attachments, []);
      await manager.execute(finished, headers);
      assert.equal(client.session.sendCalls.length, 3);

      const nextImage = { ...image, source: { ...image.source, data: "BQYHCAk=" } };
      const changed = results("Agent published more detail.", "Now use destination C.", nextImage);
      await manager.execute(changed, headers);
      assert.match(client.session.sendCalls[3].prompt, /Agent published more detail\./);
      if (siblingKind.includes("text")) assert.match(client.session.sendCalls[3].prompt, /Now use destination C\./);
      if (siblingKind.includes("image")) assert.equal(client.session.sendCalls[3].attachments[0].data, nextImage.source.data);
      await manager.execute(changed, headers);
      assert.equal(client.session.sendCalls.length, 4);
      assert.equal(client.session.handledToolCalls.length, 1);
    } finally {
      await manager.stop();
    }
  });
}

for (const withInstruction of [false, true]) {
  test(`retries only pending results after a partial multi-tool failure${withInstruction ? " without repeating user instructions" : ""}`, async () => {
    const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
    const manager = new SessionManager({
      baseDirectory: "/tmp",
      preferredModel: "gpt-5.6-sol",
      turnTimeoutMs: 100,
      client,
    });
    const headers = { "x-claude-code-session-id": "session-1" };
    const toolBody = {
      ...request(),
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
    };
    const attempts = new Map();

    client.session.sendImplementation = async ({ prompt, mode }) => {
      if (mode === "enqueue") {
        assert.equal(prompt, "Change the destination to B.");
        return;
      }
      client.session.emit("assistant.message", {
        content: "",
        toolRequests: [
          { toolCallId: "tool-1", name: "Read", arguments: {} },
          { toolCallId: "tool-2", name: "Read", arguments: {} },
        ],
        outputTokens: 1,
      });
      client.session.emit("external_tool.requested", {
        requestId: "request-1",
        toolCallId: "tool-1",
        toolName: "Read",
      });
      client.session.emit("external_tool.requested", {
        requestId: "request-2",
        toolCallId: "tool-2",
        toolName: "Read",
      });
    };
    client.session.handlePendingToolCallImplementation = async ({ requestId }) => {
      const attempt = (attempts.get(requestId) || 0) + 1;
      attempts.set(requestId, attempt);
      if (requestId === "request-2" && attempt === 1) {
        return { success: false };
      }
      if (requestId === "request-2") {
        client.session.emit("assistant.turn_start", { turnId: "turn-2" });
        client.session.emit("assistant.message", {
          content: "done",
          toolRequests: [],
          outputTokens: 1,
        });
        client.session.emit("assistant.turn_end", { turnId: "turn-2" });
      }
      return { success: true };
    };
    const resultsBody = {
      ...toolBody,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "one" },
            { type: "tool_result", tool_use_id: "tool-2", content: "two" },
            ...(withInstruction ? [{ type: "text", text: "Change the destination to B." }] : []),
          ],
        },
      ],
    };

    await manager.start();
    try {
      await manager.execute(toolBody, headers);
      await assert.rejects(
        manager.execute(resultsBody, headers),
        /rejected the result for tool call tool-2/,
      );

      const retry = await manager.execute(resultsBody, headers);
      assert.equal(retry.message.content, "done");
      assert.equal(attempts.get("request-1"), 1);
      assert.equal(attempts.get("request-2"), 2);
      assert.equal(client.session.sendCalls.filter((call) => call.mode === "enqueue").length, withInstruction ? 1 : 0);
    } finally {
      await manager.stop();
    }
  });
}

test("rejects a tool result that the Copilot session does not accept", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 100,
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
    client.session.emit("session.idle");
  };
  client.session.handlePendingToolCallImplementation = async () => ({
    success: false,
  });

  await manager.start();
  try {
    await manager.execute(toolBody, headers);
    await assert.rejects(
      manager.execute(
        {
          ...toolBody,
          messages: [
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tool-1", content: "file" },
              ],
            },
          ],
        },
        headers,
      ),
      /rejected the result for tool call tool-1/,
    );
  } finally {
    await manager.stop();
  }
});

test("finishes a turn whose tool call Copilot never registered", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  // Claude calls ExitPlanMode in plan mode even though the client never
  // declares it, so Copilot never announces a matching external tool request.
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(request(), headers);

    assert.equal(result.message.content, "Here is the plan.");
    assert.deepEqual(result.message.toolRequests, []);
    assert.deepEqual(
      diagnostics.filter(
        (event) => event.event === "bridge.unregistered_tool_call",
      ),
      [
        {
          event: "bridge.unregistered_tool_call",
          tool: "ExitPlanMode",
          toolCallId: "plan-1",
        },
      ],
    );
  } finally {
    await manager.stop();
  }
});

test("keeps a registered tool call when a sibling call is unregistered", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } },
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "tool-1",
      toolName: "Read",
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(toolBody, headers);

    assert.deepEqual(
      result.message.toolRequests.map((tool) => tool.toolCallId),
      ["tool-1"],
    );
    assert.deepEqual(
      diagnostics
        .filter((event) => event.event === "bridge.unregistered_tool_call")
        .map((event) => event.tool),
      ["ExitPlanMode"],
    );
  } finally {
    await manager.stop();
  }
});

test("drops an undeclared tool call without waiting for the pending timeout", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    // The turn has to finish well before a pending tool wait could expire.
    pendingToolWaitMs: 5000,
    turnTimeoutMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const startedAt = Date.now();
    const result = await manager.execute(request(), headers);

    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(result.message.content, "Here is the plan.");
    assert.deepEqual(result.message.toolRequests, []);
    assert.deepEqual(
      diagnostics.filter(
        (event) => event.event === "bridge.unregistered_tool_call",
      ),
      [
        {
          event: "bridge.unregistered_tool_call",
          tool: "ExitPlanMode",
          toolCallId: "plan-1",
        },
      ],
    );
  } finally {
    await manager.stop();
  }
});

test("settles a turn whose drop diagnostic throws", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    // A turn that never settles is only visible as a turn that runs out the
    // clock, so the timeout has to be short enough to fail the test.
    turnTimeoutMs: 500,
    onDiagnostic: () => {
      throw new Error("The diagnostic sink failed.");
    },
    client,
  });
  // A declared tool is dropped from the completion chain rather than from the
  // synchronous scan, which is where an unhandled rejection would strand it.
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [{ toolCallId: "read-1", name: "Read", arguments: {} }],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const startedAt = Date.now();
    const result = await manager.execute(toolBody, {
      "x-claude-code-session-id": "session-1",
    });

    assert.ok(Date.now() - startedAt < 500);
    assert.equal(result.message.content, "Here is the plan.");
    assert.deepEqual(result.message.toolRequests, []);
  } finally {
    await manager.stop();
  }
});

test("never streams a tool_use block for a dropped tool call", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    client,
  });
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-phantom",
    inputTokens: 10,
  });

  // Copilot streams the phantom call before the turn ends, so the bridge has
  // to decide whether to keep it after the bytes would already be on the wire.
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.tool_call_delta", {
      toolCallId: "plan-1",
      toolName: "ExitPlanMode",
      inputDelta: "{}",
    });
    client.session.emit("assistant.message_delta", {
      deltaContent: "Here is the plan.",
    });
    client.session.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(
      request(),
      { "x-claude-code-session-id": "session-1" },
      {
        onReady: ({ model }) => stream.start(model),
        onEvent: (event) => stream.handleSdkEvent(event),
      },
    );
    stream.finish({
      model: result.model,
      message: result.message,
      usage: result.usage,
    });
  } finally {
    await manager.stop();
  }

  const output = response.chunks.join("");
  assert.equal(output.includes('"type":"tool_use"'), false);
  const events = sseEvents(response);
  assert.deepEqual(
    events
      .filter((event) => event.type === "content_block_start")
      .map((event) => [event.index, event.content_block.type]),
    [[0, "text"]],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "content_block_stop")
      .map((event) => event.index),
    [0],
  );
  assert.equal(
    events.find((event) => event.type === "message_delta").delta.stop_reason,
    "end_turn",
  );
  assert.equal(response.ended, true);
});

test("still streams a tool_use block for a registered tool call", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    client,
  });
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-registered",
    inputTokens: 10,
  });
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.tool_call_delta", {
      toolCallId: "read-1",
      toolName: "Read",
      inputDelta: '{"file_path":',
    });
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "read-1", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
      outputTokens: 1,
    });
    client.session.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "read-1",
      toolName: "Read",
    });
    client.session.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(
      toolBody,
      { "x-claude-code-session-id": "session-1" },
      {
        onReady: ({ model }) => stream.start(model),
        onEvent: (event) => stream.handleSdkEvent(event),
      },
    );
    stream.finish({
      model: result.model,
      message: result.message,
      usage: result.usage,
    });
  } finally {
    await manager.stop();
  }

  const events = sseEvents(response);
  const start = events.find(
    (event) => event.content_block?.type === "tool_use",
  );
  assert.equal(start.content_block.name, "Read");
  assert.equal(start.content_block.id, "read-1");
  assert.deepEqual(
    JSON.parse(
      events
        .filter((event) => event.delta?.type === "input_json_delta")
        .map((event) => event.delta.partial_json)
        .join(""),
    ),
    { file_path: "/tmp/a" },
  );
  assert.equal(
    events.find((event) => event.type === "message_delta").delta.stop_reason,
    "tool_use",
  );
});

test("evicts a state whose dropped tool call is registered late", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const droppedSession = new FakeSession();
  const idleSession = new FakeSession();
  const sessions = [droppedSession, idleSession];
  client.createSessionImplementation = async () => sessions.shift();
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  droppedSession.sendImplementation = async () => {
    droppedSession.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "read-1", name: "Read", arguments: {} },
      ],
      outputTokens: 1,
    });
    droppedSession.emit("session.idle");
  };

  await manager.start();
  try {
    const result = await manager.execute(toolBody, {
      "x-claude-code-session-id": "session-1",
    });

    assert.equal(result.message.content, "Here is the plan.");
    assert.deepEqual(result.message.toolRequests, []);
    assert.deepEqual(
      diagnostics
        .filter((event) => event.event === "bridge.unregistered_tool_call")
        .map((event) => event.toolCallId),
      ["read-1"],
    );

    // Copilot registers the dropped call once the turn is already finished.
    droppedSession.emit("external_tool.requested", {
      requestId: "request-1",
      toolCallId: "read-1",
      toolName: "Read",
    });

    await manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });

    assert.equal(droppedSession.disconnectCalls, 1);
    assert.equal(idleSession.disconnectCalls, 0);
  } finally {
    await manager.stop();
  }
});

test("still aborts a turn that is waiting for an unregistered tool call", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 100,
    turnTimeoutMs: 5000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const controller = new AbortController();
  // Only a declared tool can still be registered, so only that call is waited
  // for long enough to abort.
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "partial",
      toolRequests: [
        { toolCallId: "read-1", name: "Read", arguments: {} },
      ],
      outputTokens: 1,
    });
  };

  await manager.start();
  try {
    const rejected = assert.rejects(
      manager.execute(
        toolBody,
        { "x-claude-code-session-id": "session-1" },
        { signal: controller.signal },
      ),
      { name: "AbortError" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    // The turn itself always rejects on abort, so the assertion that actually
    // separates an abort from a pending-tool timeout is what the waiter
    // reported: an abort must never be classified as an unregistered call and
    // silently drop a tool the client is still expecting.
    //
    // Outliving pendingToolWaitMs is what makes that observable. A waiter the
    // abort really cancelled stays silent forever; a waiter still armed after
    // the turn ended reaches its own timeout here and drops the call, so the
    // wait also catches an abort that never reaches the waiter at all.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(
      diagnostics.filter(
        (event) => event.event === "bridge.unregistered_tool_call",
      ),
      [],
    );
    assert.equal(client.session.abortCalls, 1);
  } finally {
    await manager.stop();
  }
});

test("shutdown aborts a stalled tool-registration turn before evicting its state", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 1000,
    turnTimeoutMs: 5000,
    client,
  });
  // Only a declared tool can still be registered, so only that call is waited
  // for long enough for the eviction to reach it.
  const toolBody = {
    ...request(),
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "partial",
      toolRequests: [
        { toolCallId: "read-1", name: "Read", arguments: {} },
      ],
      outputTokens: 1,
    });
  };

  await manager.start();
  const rejected = assert.rejects(
    manager.execute(toolBody, { "x-claude-code-session-id": "session-1" }),
    { name: "AbortError" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await manager.stop();
  await rejected;
  assert.equal(manager.states.size, 0);
});

for (const model of PRIMARY_MODELS) {
  test(`${model}: interleaved root and three workers keep colliding tool IDs isolated`, async () => {
    const actors = ["root", "alpha", "beta", "gamma"];
    const sessions = new Map();
    const client = new FakeClient(PRIMARY_MODELS.map((id) => ({ id })));
    client.createSessionImplementation = async () => {
      const actor = actors[sessions.size];
      const session = new FakeSession();
      sessions.set(actor, session);
      session.sendImplementation = async () => {
        session.emit("assistant.message", {
          content: "",
          toolRequests: [{ toolCallId: "shared-tool", name: "Read", arguments: {} }],
        });
        session.emit("external_tool.requested", {
          requestId: "shared-request", toolCallId: "shared-tool", toolName: "Read",
        });
        session.emit("session.idle");
      };
      session.handlePendingToolCallImplementation = async ({ result }) => {
        await new Promise((resolve) => setTimeout(resolve, actors.indexOf(actor) * 2));
        session.emit("assistant.message", {
          content: `${actor}:${result.textResultForLlm}`, toolRequests: [],
        });
        session.emit("session.idle");
        return { success: true };
      };
      return session;
    };
    const manager = new SessionManager({
      baseDirectory: "/tmp", preferredModel: model, turnTimeoutMs: 1000, client,
    });
    const headers = (actor) => ({
      "x-claude-code-session-id": "shared-conversation",
      ...(actor !== "root" ? { "x-claude-code-agent-id": actor } : {}),
    });
    const body = (actor) => ({
      ...request(undefined, model),
      messages: [{ role: "user", content: `Task for ${actor}` }],
      tools: [{ name: "Read", description: "Read", input_schema: { type: "object", properties: {} } }],
    });
    await manager.start();
    try {
      const initial = await Promise.all(actors.map((actor) =>
        manager.execute(body(actor), headers(actor))
      ));
      assert.equal(new Set(client.created.map((config) => config.sessionId)).size, 4);
      assert.ok(client.created.every((config) => config.model === model));
      assert.ok(initial.every((result) => result.message.toolRequests[0].toolCallId === "shared-tool"));
      const reversed = [...actors].reverse();
      const completed = await Promise.all(reversed.map((actor) => manager.execute({
        ...body(actor),
        messages: [
          ...body(actor).messages,
          { role: "assistant", content: [{ type: "tool_use", id: "shared-tool", name: "Read", input: {} }] },
          { role: "user", content: [{
            type: "tool_result", tool_use_id: "shared-tool",
            content: `PRIVATE_${actor}`, is_error: actor === "beta",
          }] },
        ],
      }, headers(actor))));
      assert.deepEqual(completed.map((result) => result.message.content),
        reversed.map((actor) => `${actor}:PRIVATE_${actor}`));
      for (const actor of actors) {
        const calls = sessions.get(actor).handledToolCalls;
        assert.equal(calls.length, 1);
        assert.equal(calls[0].requestId, "shared-request");
        assert.equal(calls[0].result.textResultForLlm, `PRIVATE_${actor}`);
        assert.equal(calls[0].result.resultType, actor === "beta" ? "failure" : "success");
      }
    } finally {
      await manager.stop();
    }
    assert.ok([...sessions.values()].every((session) => session.disconnectCalls === 1));
  });

  test(`${model}: cancelling one worker leaves its sibling and later turns usable`, async () => {
    const client = new FakeClient([{ id: model }]);
    const slow = new FakeSession();
    const healthy = new FakeSession();
    const sessions = [slow, healthy];
    client.createSessionImplementation = async () => sessions.shift();
    slow.sendImplementation = async () => {};
    const manager = new SessionManager({
      baseDirectory: "/tmp", preferredModel: model, turnTimeoutMs: 1000, client,
    });
    const headers = (agent) => ({
      "x-claude-code-session-id": "shared-conversation", "x-claude-code-agent-id": agent,
    });
    const controller = new AbortController();
    await manager.start();
    try {
      const cancelled = assert.rejects(
        manager.execute(request(undefined, model), headers("slow"), { signal: controller.signal }),
        { name: "AbortError" },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await manager.execute(request(undefined, model), headers("healthy"))).message.content, "ok");
      controller.abort();
      await cancelled;
      slow.emit("assistant.message", { content: "LATE_CANCELLED_WORKER", toolRequests: [] });
      slow.emit("session.idle");
      assert.equal((await manager.execute(request(undefined, model), headers("healthy"))).message.content, "ok");
      slow.sendImplementation = null;
      assert.equal((await manager.execute(request(undefined, model), headers("slow"))).message.content, "ok");
      assert.equal(slow.abortCalls, 1);
      assert.equal(healthy.abortCalls, 0);
      assert.equal(healthy.disconnectCalls, 0);
      assert.equal(client.created.length, 2);
    } finally {
      await manager.stop();
    }
  });
}

test("stays evictable when Copilot retries the registration of a dropped tool call", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const droppedSession = new FakeSession();
  const idleSession = new FakeSession();
  const sessions = [droppedSession, idleSession];
  client.createSessionImplementation = async () => sessions.shift();
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    maxStates: 1,
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    onDiagnostic: () => {},
    client,
  });

  droppedSession.sendImplementation = async () => {
    droppedSession.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    droppedSession.emit("session.idle");
  };

  await manager.start();
  try {
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });

    // Copilot retries the registration, so the same request arrives twice for
    // one tool call id. A marker that is consumed by the first arrival lets the
    // second one create a pending entry no client result can ever clear, and
    // both eviction gates require that map to be empty.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      droppedSession.emit("external_tool.requested", {
        requestId: "request-1",
        toolCallId: "plan-1",
        toolName: "ExitPlanMode",
      });
    }

    await manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });

    // The pinned state would survive the limit and take the healthy state's
    // place instead, so asserting on the map alone would miss the consequence.
    assert.equal(droppedSession.disconnectCalls, 1);
    assert.equal(idleSession.disconnectCalls, 0);
  } finally {
    await manager.stop();
  }
});

test("keeps an undeclared tool call Copilot registered before the turn ended", async () => {
  const client = new FakeClient([{ id: "gpt-5.6-sol" }]);
  const diagnostics = [];
  const manager = new SessionManager({
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    pendingToolWaitMs: 20,
    turnTimeoutMs: 1000,
    onDiagnostic: (event) => diagnostics.push(event),
    client,
  });
  const headers = { "x-claude-code-session-id": "session-1" };

  // Copilot registers the call before the assistant message that carries it,
  // which is the ordering #waitForPendingRequest already has to tolerate.
  client.session.sendImplementation = async () => {
    client.session.emit("external_tool.requested", {
      requestId: "request-plan-1",
      toolCallId: "plan-1",
      toolName: "ExitPlanMode",
    });
    client.session.emit("assistant.message", {
      content: "Here is the plan.",
      toolRequests: [
        { toolCallId: "plan-1", name: "ExitPlanMode", arguments: {} },
      ],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
  };
  client.session.handlePendingToolCallImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "approved",
      toolRequests: [],
      outputTokens: 1,
    });
    client.session.emit("session.idle");
    return { success: true };
  };

  await manager.start();
  try {
    const first = await manager.execute(request(), headers);

    // Only the client can answer a registered call, so dropping it strands
    // Copilot mid-turn on a result that can never arrive.
    assert.deepEqual(
      first.message.toolRequests.map((tool) => tool.toolCallId),
      ["plan-1"],
    );
    assert.deepEqual(
      diagnostics.filter(
        (event) => event.event === "bridge.unregistered_tool_call",
      ),
      [],
    );

    const second = await manager.execute(
      {
        ...request(),
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "plan-1", content: "ok" },
            ],
          },
        ],
      },
      headers,
    );

    assert.equal(second.message.content, "approved");
    assert.deepEqual(
      client.session.handledToolCalls.map((call) => call.requestId),
      ["request-plan-1"],
    );
  } finally {
    await manager.stop();
  }
});

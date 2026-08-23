import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "../src/session-manager.mjs";

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

function request(effort, model = "gpt-5.6-sol") {
  return {
    model,
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    output_config: { effort },
  };
}

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
      enabled: true,
      deferThreshold: 30,
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
  const manager = new SessionManager({
    abortTimeoutMs: 20,
    baseDirectory: "/tmp",
    preferredModel: "gpt-5.6-sol",
    turnTimeoutMs: 10_000,
    client,
  });
  const controller = new AbortController();
  client.session.abortImplementation = () => new Promise(() => {});
  client.session.sendImplementation = async () => controller.abort();

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
    client.session.abortImplementation = null;
    client.session.sendImplementation = null;
    const next = await manager.execute(request(), {
      "x-claude-code-session-id": "session-1",
    });
    assert.equal(next.message.content, "ok");
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
  client.session.sendImplementation = async () => {
    client.session.emit("assistant.message", {
      content: "",
      toolRequests: [
        { toolCallId: "tool-1", name: "Read", arguments: {} },
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
    await manager.execute(toolBody, {
      "x-claude-code-session-id": "session-1",
    });
    client.session.sendImplementation = null;
    await manager.execute(request(), {
      "x-claude-code-session-id": "session-2",
    });
    assert.equal(client.session.disconnectCalls, 0);
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
            content: "Tool execution completed.",
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
            content: "Tool execution completed.",
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
    assert.equal(client.created[0].tools[0].defer, "auto");
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

test("retries only pending results after a partial multi-tool failure", async () => {
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

  client.session.sendImplementation = async () => {
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
  } finally {
    await manager.stop();
  }
});

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

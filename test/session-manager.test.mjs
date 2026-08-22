import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "../src/session-manager.mjs";

class FakeSession {
  constructor() {
    this.handlers = new Map();
    this.setModelCalls = [];
    this.rpc = {
      tools: {
        handlePendingToolCall: async () => {},
      },
    };
  }

  on(type, handler) {
    const handlers = this.handlers.get(type) || new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => handlers.delete(handler);
  }

  emit(type, data = {}) {
    for (const handler of this.handlers.get(type) || []) {
      handler({ type, data });
    }
  }

  async send() {
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

  async disconnect() {}
}

class FakeClient {
  constructor(models) {
    this.models = models;
    this.created = [];
    this.session = new FakeSession();
  }

  async start() {}

  async stop() {}

  async listModels() {
    return this.models;
  }

  async listSessions() {
    return [];
  }

  async createSession(config) {
    this.created.push(config);
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

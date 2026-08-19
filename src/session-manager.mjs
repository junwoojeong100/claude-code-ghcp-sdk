import { createHash } from "node:crypto";

import { CopilotClient, defineTool } from "@github/copilot-sdk";

import {
  extractSystem,
  extractTurnInput,
  serializeConversation,
} from "./anthropic.mjs";
import { resolveCopilotModel } from "./model-map.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toolSignature(tools = []) {
  return hash(
    JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    ),
  ).slice(0, 16);
}

function makeTools(tools = []) {
  return tools.map((tool) =>
    defineTool(tool.name, {
      description: tool.description,
      parameters: tool.input_schema || { type: "object", properties: {} },
      skipPermission: true,
      defer: "never",
      overridesBuiltInTool: true,
    }),
  );
}

function header(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export class SessionManager {
  constructor({
    baseDirectory,
    preferredModel,
    logLevel = "error",
    turnTimeoutMs = 300_000,
  }) {
    this.client = new CopilotClient({
      mode: "empty",
      baseDirectory,
      logLevel,
    });
    this.preferredModel = preferredModel;
    this.turnTimeoutMs = turnTimeoutMs;
    this.models = [];
    this.knownSessionIds = new Set();
    this.states = new Map();
  }

  async start() {
    await this.client.start();
    this.models = await this.client.listModels();
    const sessions = await this.client.listSessions().catch(() => []);
    this.knownSessionIds = new Set(sessions.map((session) => session.sessionId));
  }

  listModels() {
    return [...this.models];
  }

  async stop() {
    for (const state of this.states.values()) {
      await state.session.disconnect().catch(() => {});
    }
    await this.client.stop();
  }

  resolveModel(requested) {
    return resolveCopilotModel({
      requested,
      availableIds: this.models.map((model) => model.id),
      preferredModel: this.preferredModel,
    });
  }

  async execute(body, headers, callbacks = {}) {
    const state = await this.#stateFor(body, headers);
    callbacks.onReady?.({ model: state.model });
    const run = state.queue.then(() =>
      this.#executeLocked(state, body, callbacks.onEvent),
    );
    state.queue = run.catch(() => {});
    return run;
  }

  async #stateFor(body, headers) {
    const model = this.resolveModel(body.model);
    const claudeSessionId = header(headers, "x-claude-code-session-id") || "default";
    const claudeAgentId = header(headers, "x-claude-code-agent-id") || "root";
    const signature = toolSignature(body.tools);
    const key = `${claudeSessionId}:${claudeAgentId}:${model}:${signature}`;

    const existing = this.states.get(key);
    if (existing) return existing;

    const tools = makeTools(body.tools);
    const sessionId = `claude-ghcp-${hash(key).slice(0, 32)}`;
    const common = {
      model,
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      tools,
      toolSearch: { enabled: false },
      streaming: true,
      infiniteSessions: { enabled: false },
      systemMessage: {
        mode: "replace",
        content: extractSystem(body.system),
      },
    };

    let session;
    let resumed = false;
    if (this.knownSessionIds.has(sessionId)) {
      try {
        session = await this.client.resumeSession(sessionId, {
          ...common,
          continuePendingWork: true,
        });
        resumed = true;
      } catch {
        this.knownSessionIds.delete(sessionId);
      }
    }

    if (!session) {
      session = await this.client.createSession({ sessionId, ...common });
      this.knownSessionIds.add(sessionId);
    }

    const state = {
      key,
      model,
      session,
      resumed,
      fresh: !resumed,
      queue: Promise.resolve(),
      pendingByToolCallId: new Map(),
      lastAssistantMessage: null,
    };

    session.on("assistant.message", (event) => {
      if (!event.agentId) state.lastAssistantMessage = event.data;
    });
    session.on("external_tool.requested", (event) => {
      if (!event.agentId) {
        state.pendingByToolCallId.set(event.data.toolCallId, event.data.requestId);
      }
    });

    this.states.set(key, state);
    return state;
  }

  async #executeLocked(state, body, onEvent) {
    const input = extractTurnInput(body);

    if (input.kind === "tool-results") {
      return this.#waitForTurn(state, async () => {
        await Promise.all(
          input.toolResults.map(async ({ toolUseId, value }) => {
            const requestId = await this.#waitForPendingRequest(state, toolUseId);
            state.pendingByToolCallId.delete(toolUseId);
            await state.session.rpc.tools.handlePendingToolCall({
              requestId,
              result: value,
            });
          }),
        );
      }, onEvent);
    }

    let prompt = input.prompt;
    if (state.fresh && (body.messages?.length || 0) > 1) {
      const prior = serializeConversation(body.messages.slice(0, -1));
      prompt = `<prior_conversation>\n${prior}\n</prior_conversation>\n\n${prompt}`;
    }
    state.fresh = false;

    return this.#waitForTurn(
      state,
      () =>
        state.session.send({
          prompt,
          attachments: input.attachments,
        }),
      onEvent,
    );
  }

  #waitForTurn(state, trigger, onEvent) {
    state.lastAssistantMessage = null;
    const messages = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("Timed out waiting for the GitHub Copilot model turn."));
      }, this.turnTimeoutMs);

      const finish = (error, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        offMessage();
        offMessageDelta();
        offToolCallDelta();
        offIdle();
        offError();
        if (error) reject(error);
        else resolve({ model: state.model, message });
      };

      const onMessage = (event) => {
        if (event.agentId) return;
        state.lastAssistantMessage = event.data;
        messages.push(event.data);
        if (event.data.toolRequests?.length) {
          const combined = this.#combineMessages(messages);
          void this.#waitForAllPending(state, combined.toolRequests)
            .then(() => finish(null, combined))
            .catch((error) => finish(error));
        }
      };
      const onIdle = () => {
        finish(
          null,
          messages.length
            ? this.#combineMessages(messages)
            : state.lastAssistantMessage || { content: "", toolRequests: [] },
        );
      };
      const onError = (event) => {
        finish(new Error(event.data?.message || "GitHub Copilot SDK session error."));
      };

      const offMessage = state.session.on("assistant.message", onMessage);
      const offMessageDelta = state.session.on("assistant.message_delta", (event) => {
        onEvent?.(event);
      });
      const offToolCallDelta = state.session.on("assistant.tool_call_delta", (event) => {
        onEvent?.(event);
      });
      const offIdle = state.session.on("session.idle", onIdle);
      const offError = state.session.on("session.error", onError);

      Promise.resolve(trigger()).catch((error) => finish(error));
    });
  }

  #combineMessages(messages) {
    return {
      ...messages.at(-1),
      content: messages.map((message) => message.content || "").join(""),
      toolRequests: messages.flatMap((message) => message.toolRequests || []),
      outputTokens: messages.reduce(
        (total, message) => total + (message.outputTokens || 0),
        0,
      ),
    };
  }

  async #waitForAllPending(state, toolRequests) {
    await Promise.all(
      toolRequests.map((request) =>
        this.#waitForPendingRequest(state, request.toolCallId),
      ),
    );
  }

  async #waitForPendingRequest(state, toolCallId) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const requestId = state.pendingByToolCallId.get(toolCallId);
      if (requestId) return requestId;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No pending GitHub Copilot tool call found for ${toolCallId}.`);
  }
}

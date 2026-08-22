import { createHash } from "node:crypto";

import { CopilotClient, defineTool } from "@github/copilot-sdk";

import {
  extractReasoningEffort,
  extractSystem,
  extractTurnInput,
  serializeConversation,
} from "./anthropic.mjs";
import {
  resolveCopilotModel,
  resolveReasoningEffort,
} from "./model-map.mjs";

const CONTINUATION_PROMPT =
  "Continue from the prior conversation and follow the current system instructions.";

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

function createSdkTools(tools = []) {
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

function firstHeaderValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function createStateKey({ headers, model, systemMessage, tools }) {
  const claudeSessionId =
    firstHeaderValue(headers, "x-claude-code-session-id") || "default";
  const claudeAgentId =
    firstHeaderValue(headers, "x-claude-code-agent-id") || "root";

  return [
    claudeSessionId,
    claudeAgentId,
    model,
    toolSignature(tools),
    hash(systemMessage).slice(0, 16),
  ].join(":");
}

export class SessionManager {
  constructor({
    baseDirectory,
    preferredModel,
    logLevel = "error",
    turnTimeoutMs = 300_000,
    client,
  }) {
    this.client =
      client ??
      new CopilotClient({
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

  resolveReasoningEffort(modelId, requested) {
    const model = this.models.find((candidate) => candidate.id === modelId);
    return resolveReasoningEffort({ requested, model });
  }

  async execute(body, headers, { onReady, onEvent } = {}) {
    const model = this.resolveModel(body.model);
    const reasoningEffort = this.resolveReasoningEffort(
      model,
      extractReasoningEffort(body),
    );
    const state = await this.#getOrCreateState(body, headers, {
      model,
      reasoningEffort,
    });
    onReady?.({ model: state.model });
    const run = state.queue.then(() =>
      this.#executeLocked(state, body, reasoningEffort, onEvent),
    );
    // A rejected turn must not prevent later requests from using this session.
    state.queue = run.catch(() => {});
    return run;
  }

  async #getOrCreateState(body, headers, { model, reasoningEffort }) {
    const systemMessage = extractSystem(body.system);
    const key = createStateKey({
      headers,
      model,
      systemMessage,
      tools: body.tools,
    });

    const existing = this.states.get(key);
    if (existing) return existing;

    const tools = createSdkTools(body.tools);
    const sessionId = `claude-ghcp-${hash(key).slice(0, 32)}`;
    const sessionOptions = {
      model,
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      tools,
      toolSearch: { enabled: false },
      streaming: true,
      infiniteSessions: { enabled: false },
      systemMessage: {
        mode: "replace",
        content: systemMessage,
      },
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };

    let session;
    let resumed = false;
    if (this.knownSessionIds.has(sessionId)) {
      try {
        session = await this.client.resumeSession(sessionId, {
          ...sessionOptions,
          continuePendingWork: true,
        });
        resumed = true;
      } catch {
        this.knownSessionIds.delete(sessionId);
      }
    }

    if (!session) {
      session = await this.client.createSession({
        sessionId,
        ...sessionOptions,
      });
      this.knownSessionIds.add(sessionId);
    }

    const state = {
      model,
      reasoningEffort,
      session,
      fresh: !resumed,
      queue: Promise.resolve(),
      pendingByToolCallId: new Map(),
    };

    session.on("external_tool.requested", (event) => {
      this.#rememberPendingRequest(state, event);
    });
    session.on("external_tool.completed", (event) => {
      this.#forgetPendingRequest(state, event.data.requestId);
    });

    this.states.set(key, state);
    return state;
  }

  async #executeLocked(state, body, reasoningEffort, onEvent) {
    await this.#applyReasoningEffort(state, reasoningEffort);
    const input = extractTurnInput(body);

    if (input.kind === "tool-results" && !state.fresh) {
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

    const messages = body.messages || [];
    let prompt = input.kind === "prompt" ? input.prompt : CONTINUATION_PROMPT;
    const attachments = input.kind === "prompt" ? input.attachments : [];
    if (state.fresh && messages.length) {
      // Forked agents can start with inherited history that ends in an assistant
      // message or an already-completed parent tool result.
      const priorMessages = input.kind === "prompt" ? messages.slice(0, -1) : messages;
      if (priorMessages.length) {
        const prior = serializeConversation(priorMessages);
        prompt = `<prior_conversation>\n${prior}\n</prior_conversation>\n\n${prompt || CONTINUATION_PROMPT}`;
      }
    }
    state.fresh = false;

    return this.#waitForTurn(
      state,
      () => state.session.send({ prompt: prompt || CONTINUATION_PROMPT, attachments }),
      onEvent,
    );
  }

  async #applyReasoningEffort(state, reasoningEffort) {
    if (reasoningEffort === state.reasoningEffort) return;

    await state.session.setModel(
      state.model,
      reasoningEffort ? { reasoningEffort } : undefined,
    );
    state.reasoningEffort = reasoningEffort;
  }

  #waitForTurn(state, trigger, onEvent) {
    const messages = [];
    const subscriptions = [];
    let pendingToolResponse = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("Timed out waiting for the GitHub Copilot model turn."));
      }, this.turnTimeoutMs);

      const finish = (error, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        for (const unsubscribe of subscriptions) unsubscribe();
        if (error) reject(error);
        else resolve({ model: state.model, message });
      };

      const onMessage = (event) => {
        if (event.agentId) return;
        messages.push(event.data);
        if (event.data.toolRequests?.length) {
          const combined = this.#combineMessages(messages);
          pendingToolResponse = Promise.all(
            combined.toolRequests.map((request) =>
              this.#waitForPendingRequest(state, request.toolCallId),
            ),
          ).then(() => combined);
          void pendingToolResponse
            .then((message) => finish(null, message))
            .catch((error) => finish(error));
        }
      };
      const onIdle = () => {
        if (pendingToolResponse) return;
        finish(
          null,
          messages.length
            ? this.#combineMessages(messages)
            : { content: "", toolRequests: [] },
        );
      };
      const onError = (event) => {
        finish(new Error(event.data?.message || "GitHub Copilot SDK session error."));
      };

      subscriptions.push(
        state.session.on("assistant.message", onMessage),
        state.session.on("assistant.message_delta", (event) => {
          onEvent?.(event);
        }),
        state.session.on("assistant.tool_call_delta", (event) => {
          onEvent?.(event);
        }),
        state.session.on("session.idle", onIdle),
        state.session.on("session.error", onError),
      );

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

  #rememberPendingRequest(state, event) {
    state.pendingByToolCallId.set(
      event.data.toolCallId,
      event.data.requestId,
    );
  }

  #forgetPendingRequest(state, requestId) {
    for (const [toolCallId, pendingRequestId] of state.pendingByToolCallId) {
      if (pendingRequestId === requestId) {
        state.pendingByToolCallId.delete(toolCallId);
        return;
      }
    }
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

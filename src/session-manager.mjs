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
const BACKGROUND_TOOL_WAIT_MESSAGE =
  "Waiting for the background tool to finish.";
const TOOL_RESULT_UPDATE_PROMPT =
  "A previously started external tool has produced an additional result. " +
  "Use the update below to continue the current task.";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toolResultHash(value, prompt, toolName) {
  return hash(
    JSON.stringify({
      ...(toolName === "Agent" ? { prompt } : {}),
      value,
    }),
  );
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
      completedToolCalls: new Map(),
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
      const results = input.toolResults.map((result) => ({
        ...result,
        resultHash: toolResultHash(
          result.value,
          input.prompt,
          state.completedToolCalls.get(result.toolUseId)?.toolName,
        ),
        completed: state.completedToolCalls.get(result.toolUseId),
      }));
      const changedCompleted = results.filter(
        (result) =>
          result.completed &&
          result.completed.resultHash !== result.resultHash,
      );
      const pendingResults = results.filter((result) => !result.completed);
      if (changedCompleted.length) {
        if (pendingResults.length) {
          throw new Error(
            "Cannot process updated and pending tool results in the same turn.",
          );
        }
        if (
          changedCompleted.some(
            (result) => result.completed.toolName !== "Agent",
          )
        ) {
          throw new Error(
            "Only background Agent tool calls can publish updated results.",
          );
        }
        const prompt = [
          TOOL_RESULT_UPDATE_PROMPT,
          ...changedCompleted.map(({ value }) => value.textResultForLlm),
          input.prompt,
        ]
          .filter(Boolean)
          .join("\n\n");
        const turn = await this.#waitForTurn(
          state,
          () => state.session.send({ prompt, attachments: [] }),
          onEvent,
        );
        for (const result of changedCompleted) {
          state.completedToolCalls.set(result.toolUseId, {
            ...result.completed,
            lastTurn: turn,
            resultHash: result.resultHash,
          });
        }
        return turn;
      }

      if (!pendingResults.length) {
        const cachedTurn = results.findLast(
          (result) => result.completed.lastTurn,
        )?.completed.lastTurn;
        if (cachedTurn) return cachedTurn;

        return this.#waitForTurn(
          state,
          () =>
            state.session.send({
              prompt: CONTINUATION_PROMPT,
              attachments: [],
            }),
          onEvent,
        );
      }

      const handledTools = [];
      const turn = await this.#waitForTurn(state, async () => {
        const submissions = await Promise.allSettled(
          pendingResults.map(async ({ toolUseId, value }) => {
            const pending = await this.#waitForPendingRequest(state, toolUseId);
            const response = await state.session.rpc.tools.handlePendingToolCall({
              requestId: pending.requestId,
              result: value,
            });
            if (response?.success === false) {
              throw new Error(
                `GitHub Copilot rejected the result for tool call ${toolUseId}.`,
              );
            }
            state.pendingByToolCallId.delete(toolUseId);
            const completed = {
              lastTurn: null,
              resultHash: toolResultHash(
                value,
                input.prompt,
                pending.toolName,
              ),
              toolName: pending.toolName,
            };
            state.completedToolCalls.set(toolUseId, completed);
            handledTools.push({ completed, toolUseId });
          }),
        );
        const failure = submissions.find(
          (submission) => submission.status === "rejected",
        );
        if (failure) throw failure.reason;
      }, onEvent);
      let completedTurn = turn;
      if (
        handledTools.some(({ completed }) => completed.toolName === "Agent") &&
        !turn.message.content &&
        !turn.message.toolRequests?.length
      ) {
        completedTurn = {
          ...turn,
          message: {
            ...turn.message,
            content: BACKGROUND_TOOL_WAIT_MESSAGE,
          },
        };
      }
      for (const { completed } of handledTools) {
        completed.lastTurn = completedTurn;
      }
      for (const result of results) {
        if (result.completed && !result.completed.lastTurn) {
          result.completed.lastTurn = completedTurn;
        }
      }
      return completedTurn;
    }

    const messages = body.messages || [];
    let prompt = input.kind === "prompt" ? input.prompt : CONTINUATION_PROMPT;
    const attachments = input.kind === "prompt" ? input.attachments : [];
    if (state.fresh && messages.length) {
      // Forked agents can start with inherited history that ends in an assistant
      // message or an already-completed parent tool result.
      const priorMessages =
        input.kind === "prompt"
          ? messages.slice(0, input.messageIndex)
          : messages;
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

    return new Promise((resolve, reject) => {
      let settled = false;
      let completionStarted = false;
      let turnStarted = false;
      let triggerFinished = false;
      let deferredCompletion = null;
      const timeout = setTimeout(() => {
        finish(new Error("Timed out waiting for the GitHub Copilot model turn."));
      }, this.turnTimeoutMs);

      const settle = (error, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        for (const unsubscribe of subscriptions) unsubscribe();
        if (error) reject(error);
        else resolve({ model: state.model, message });
      };
      const finish = (error, message) => {
        if (error || triggerFinished) {
          settle(error, message);
          return;
        }
        deferredCompletion = { message };
      };

      const finishTurn = () => {
        if (settled || completionStarted || !turnStarted) return;

        const combined = messages.length
          ? this.#combineMessages(messages)
          : { content: "", toolRequests: [] };
        if (!combined.toolRequests.length) {
          finish(null, combined);
          return;
        }

        completionStarted = true;
        Promise.all(
          combined.toolRequests.map((request) =>
            this.#waitForPendingRequest(state, request.toolCallId),
          ),
        )
          .then(() => finish(null, combined))
          .catch((error) => finish(error));
      };

      const onMessage = (event) => {
        if (event.agentId) return;
        turnStarted = true;
        messages.push(event.data);
        const { chunkCount, chunkIndex } = event.data;
        const finalChunk =
          !Number.isInteger(chunkCount) ||
          !Number.isInteger(chunkIndex) ||
          chunkIndex === chunkCount - 1;
        if (
          finalChunk &&
          messages.some((message) => message.toolRequests?.length)
        ) {
          finishTurn();
        }
      };
      const onTurnStart = (event) => {
        if (!event.agentId) turnStarted = true;
      };
      const onTurnEnd = (event) => {
        if (!event.agentId) finishTurn();
      };
      const onError = (event) => {
        finish(new Error(event.data?.message || "GitHub Copilot SDK session error."));
      };

      subscriptions.push(
        state.session.on("assistant.turn_start", onTurnStart),
        state.session.on("assistant.message", onMessage),
        state.session.on("assistant.message_delta", (event) => {
          onEvent?.(event);
        }),
        state.session.on("assistant.tool_call_delta", (event) => {
          onEvent?.(event);
        }),
        state.session.on("assistant.turn_end", onTurnEnd),
        state.session.on("session.idle", finishTurn),
        state.session.on("session.error", onError),
      );

      Promise.resolve(trigger())
        .then(() => {
          triggerFinished = true;
          if (deferredCompletion) {
            settle(null, deferredCompletion.message);
          }
        })
        .catch((error) => settle(error));
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
      {
        requestId: event.data.requestId,
        toolName: event.data.toolName,
      },
    );
  }

  #forgetPendingRequest(state, requestId) {
    for (const [toolCallId, pending] of state.pendingByToolCallId) {
      if (pending.requestId === requestId) {
        state.pendingByToolCallId.delete(toolCallId);
        return;
      }
    }
  }

  async #waitForPendingRequest(state, toolCallId) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = state.pendingByToolCallId.get(toolCallId);
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No pending GitHub Copilot tool call found for ${toolCallId}.`);
  }
}

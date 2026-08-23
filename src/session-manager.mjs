import { createHash } from "node:crypto";

import { CopilotClient, defineTool } from "@github/copilot-sdk";

import {
  extractReasoningEffort,
  extractSystem,
  extractTurnInput,
  serializeConversationTail,
} from "./anthropic.mjs";
import {
  abortSession,
  deleteClientSession,
  disconnectSession,
  submitToolResult,
} from "./copilot-session-rpc.mjs";
import {
  resolveCopilotModel,
  resolveReasoningEffort,
} from "./model-map.mjs";
import { applyRequestPolicy } from "./request-policy.mjs";

const CONTINUATION_PROMPT =
  "Continue from the prior conversation and follow the current system instructions.";
const BACKGROUND_TOOL_WAIT_MESSAGE =
  "Waiting for the background tool to finish.";
const TOOL_RESULT_UPDATE_PROMPT =
  "A previously started external tool has produced an additional result. " +
  "Use the update below to continue the current task.";
const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024;
const DEFAULT_MAX_STATES = 64;
const DEFAULT_STATE_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PENDING_TOOL_WAIT_MS = 10_000;
const DEFAULT_MAX_TOOL_RESULTS = 32;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

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
      defer: "auto",
      overridesBuiltInTool: true,
    }),
  );
}

function firstHeaderValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function createStateIdentity({ headers, model, systemMessage, tools }) {
  const claudeSessionId =
    firstHeaderValue(headers, "x-claude-code-session-id") || "default";
  const claudeAgentId =
    firstHeaderValue(headers, "x-claude-code-agent-id") || "root";
  const parts = {
    claudeAgentId,
    claudeSessionId,
    model,
    systemHash: hash(systemMessage).slice(0, 16),
    toolSignature: toolSignature(tools),
  };
  return {
    familyKey: [claudeSessionId, claudeAgentId].join(":"),
    key: [
    claudeSessionId,
    claudeAgentId,
    model,
      parts.toolSignature,
      parts.systemHash,
    ].join(":"),
    parts,
  };
}

function createAbortError() {
  const error = new Error("The Claude Code request was aborted.");
  error.name = "AbortError";
  return error;
}

function aggregateUsage(events) {
  if (!events.length) return null;
  return events.reduce(
    (usage, event) => ({
      cacheReadTokens:
        usage.cacheReadTokens + (event.cacheReadTokens || 0),
      cacheWriteTokens:
        usage.cacheWriteTokens + (event.cacheWriteTokens || 0),
      contentFilterTriggered:
        usage.contentFilterTriggered ||
        Boolean(event.contentFilterTriggered),
      finishReason: event.finishReason || usage.finishReason,
      inputTokens: usage.inputTokens + (event.inputTokens || 0),
      outputTokens: usage.outputTokens + (event.outputTokens || 0),
      reasoningTokens:
        usage.reasoningTokens + (event.reasoningTokens || 0),
    }),
    {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contentFilterTriggered: false,
      finishReason: null,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  );
}

function historySnapshot(messages = []) {
  return messages.map((message) => ({
    hash: hash(JSON.stringify(message)),
    role: message?.role,
    toolResultIds: Array.isArray(message?.content)
      ? message.content
          .filter((block) => block?.type === "tool_result")
          .map((block) => block.tool_use_id)
          .sort()
      : [],
  }));
}

function historiesDiverged(previous, current, knownToolIds = new Set()) {
  if (!previous) return false;
  if (current.length < previous.length) return true;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index].hash === current[index]?.hash) continue;
    const previousIds = previous[index].toolResultIds;
    const currentIds = current[index]?.toolResultIds || [];
    const compatibleToolUpdate =
      index === previous.length - 1 &&
      current[index]?.role === "user" &&
      currentIds.length > 0 &&
      currentIds.every((id) => knownToolIds.has(id)) &&
      (previousIds.length === 0 ||
        (previousIds.length === currentIds.length &&
          previousIds.every(
            (id, toolIndex) => id === currentIds[toolIndex],
          )));
    if (!compatibleToolUpdate) return true;
  }
  return false;
}

export class SessionManager {
  constructor({
    baseDirectory,
    preferredModel,
    logLevel = "error",
    turnTimeoutMs = 300_000,
    maxReplayBytes = DEFAULT_MAX_REPLAY_BYTES,
    maxStates = DEFAULT_MAX_STATES,
    maxToolResults = DEFAULT_MAX_TOOL_RESULTS,
    onDiagnostic,
    abortTimeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
    pendingToolWaitMs = DEFAULT_PENDING_TOOL_WAIT_MS,
    stateIdleTtlMs = DEFAULT_STATE_IDLE_TTL_MS,
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
    this.maxReplayBytes = maxReplayBytes;
    this.maxStates = maxStates;
    this.maxToolResults = maxToolResults;
    this.abortTimeoutMs = abortTimeoutMs;
    this.onDiagnostic = onDiagnostic || (() => {});
    this.pendingToolWaitMs = pendingToolWaitMs;
    this.stateIdleTtlMs = stateIdleTtlMs;
    this.models = [];
    this.knownSessionIds = new Set();
    this.stateCreations = new Map();
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
    await Promise.allSettled(this.stateCreations.values());
    for (const [key, state] of this.states) {
      await this.#evictState(key, state, { abort: true });
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

  async execute(body, headers, { onReady, onEvent, signal } = {}) {
    if (signal?.aborted) throw createAbortError();
    await this.#evictExpiredStates();
    body = applyRequestPolicy(body, this.onDiagnostic);
    const model = this.resolveModel(body.model);
    const reasoningEffort = this.resolveReasoningEffort(
      model,
      extractReasoningEffort(body),
    );
    let state = await this.#getOrCreateState(body, headers, {
      model,
      reasoningEffort,
    });
    const currentHistory = historySnapshot(body.messages);
    const knownToolIds = new Set([
      ...state.pendingByToolCallId.keys(),
      ...state.completedToolCalls.keys(),
    ]);
    if (
      historiesDiverged(
        state.historySnapshot,
        currentHistory,
        knownToolIds,
      )
    ) {
      this.onDiagnostic({
        event: "bridge.history_reconciled",
        currentMessages: currentHistory.length,
        previousMessages: state.historySnapshot.length,
      });
      await this.#evictState(state.identity.key, state, {
        abort: true,
        deletePersisted: true,
      });
      state = await this.#getOrCreateState(body, headers, {
        model,
        reasoningEffort,
      });
    }
    state.historySnapshot = currentHistory;
    state.lastUsedAt = Date.now();
    onReady?.({ model: state.model });
    const run = state.queue.then(() =>
      this.#executeLocked(state, body, reasoningEffort, onEvent, signal),
    );
    // A rejected turn must not prevent later requests from using this session.
    state.activeTurns += 1;
    state.queue = run
      .catch(() => {})
      .finally(() => {
        state.activeTurns -= 1;
        state.lastUsedAt = Date.now();
      });
    return run;
  }

  async #getOrCreateState(body, headers, { model, reasoningEffort }) {
    const systemMessage = extractSystem(body.system);
    const identity = createStateIdentity({
      headers,
      model,
      systemMessage,
      tools: body.tools,
    });
    const { key } = identity;

    const existing = this.states.get(key);
    if (existing) return existing;
    const inFlight = this.stateCreations.get(key);
    if (inFlight) return inFlight;

    const sibling = [...this.states.values()].find(
      (state) => state.identity.familyKey === identity.familyKey,
    );
    if (sibling) {
      this.onDiagnostic({
        event: "bridge.state_split",
        family: hash(identity.familyKey).slice(0, 12),
        changes: ["model", "toolSignature", "systemHash"].filter(
          (field) =>
            sibling.identity.parts[field] !== identity.parts[field],
        ),
      });
    }

    const creation = (async () => {
    const tools = createSdkTools(body.tools);
    const sessionId = `claude-ghcp-${hash(key).slice(0, 32)}`;
    const sessionOptions = {
      model,
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      tools,
      toolSearch: { enabled: true, deferThreshold: 30 },
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
      activeTurns: 0,
      reasoningEffort,
      session,
      sessionId,
      fresh: !resumed,
      identity,
      historySnapshot: null,
      lastUsedAt: Date.now(),
      queue: Promise.resolve(),
      pendingByToolCallId: new Map(),
      pendingRequestWaiters: new Map(),
      completedToolCalls: new Map(),
    };

    session.on("external_tool.requested", (event) => {
      this.#rememberPendingRequest(state, event);
    });
    session.on("external_tool.completed", (event) => {
      this.#forgetPendingRequest(state, event.data.requestId);
    });
    for (const eventType of [
      "session.compaction_complete",
      "session.context_cleared",
      "session.snapshot_rewind",
      "session.truncation",
    ]) {
      session.on(eventType, () => {
        state.completedToolCalls.clear();
        state.pendingByToolCallId.clear();
        for (const waiters of state.pendingRequestWaiters.values()) {
          for (const waiter of waiters) {
            waiter.reject(
              new Error("Tool result wait was invalidated by history change."),
            );
          }
        }
        state.pendingRequestWaiters.clear();
      });
    }

    this.states.set(key, state);
    await this.#enforceStateLimit(key);
    return state;
    })();
    this.stateCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      this.stateCreations.delete(key);
    }
  }

  async #executeLocked(state, body, reasoningEffort, onEvent, signal) {
    if (signal?.aborted) throw createAbortError();
    await this.#applyReasoningEffort(state, reasoningEffort);
    const input = extractTurnInput(body);

    if (input.kind === "tool-results" && !state.fresh) {
      if (input.toolResults.length > this.maxToolResults) {
        throw new Error(
          `A turn cannot return more than ${this.maxToolResults} tool results.`,
        );
      }
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
          signal,
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
          signal,
        );
      }

      const handledTools = [];
      const turn = await this.#waitForTurn(state, async () => {
        const submissions = await Promise.allSettled(
          pendingResults.map(async ({ toolUseId, value }) => {
            const pending = await this.#waitForPendingRequest(
              state,
              toolUseId,
              signal,
            );
            await submitToolResult(
              state.session,
              {
                requestId: pending.requestId,
                result: value,
              },
              { toolCallId: toolUseId },
            );
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
      }, onEvent, signal);
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
        const prior = serializeConversationTail(
          priorMessages,
          this.maxReplayBytes,
        );
        if (prior.truncated) {
          this.onDiagnostic({
            event: "bridge.history_replay_truncated",
            maxBytes: this.maxReplayBytes,
            messages: priorMessages.length,
          });
        }
        prompt = `<prior_conversation>\n${prior.text}\n</prior_conversation>\n\n${prompt || CONTINUATION_PROMPT}`;
      }
    }
    state.fresh = false;

    return this.#waitForTurn(
      state,
      () => state.session.send({ prompt: prompt || CONTINUATION_PROMPT, attachments }),
      onEvent,
      signal,
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

  #waitForTurn(state, trigger, onEvent, signal) {
    const messages = [];
    const subscriptions = [];
    const usageEvents = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      let completionStarted = false;
      let turnStarted = false;
      let triggerFinished = false;
      let deferredCompletion = null;
      let aborting = false;
      const onAbort = () => {
        if (settled || aborting) return;
        aborting = true;
        let abortTimer;
        const abortDeadline = new Promise((resolve) => {
          abortTimer = setTimeout(resolve, this.abortTimeoutMs);
        });
        void Promise.race([
          abortSession(state.session).catch(() => {}),
          abortDeadline,
        ])
          .finally(() => clearTimeout(abortTimer))
          .then(() => settle(createAbortError()));
      };
      const timeout = setTimeout(() => {
        finish(new Error("Timed out waiting for the GitHub Copilot model turn."));
      }, this.turnTimeoutMs);

      const settle = (error, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        for (const unsubscribe of subscriptions) unsubscribe();
        if (error) reject(error);
        else {
          resolve({
            model: state.model,
            message,
            usage: aggregateUsage(usageEvents),
          });
        }
      };
      const finish = (error, message) => {
        if (aborting) return;
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
            this.#waitForPendingRequest(
              state,
              request.toolCallId,
              signal,
            ),
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
        state.session.on("assistant.usage", (event) => {
          if (!event.agentId) usageEvents.push(event.data);
        }),
        state.session.on("assistant.turn_end", onTurnEnd),
        state.session.on("session.idle", finishTurn),
        state.session.on("session.error", onError),
      );

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      Promise.resolve(trigger())
        .then(() => {
          triggerFinished = true;
          if (!aborting && deferredCompletion) {
            settle(null, deferredCompletion.message);
          }
        })
        .catch((error) => {
          if (!aborting) settle(error);
        });
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
    const pending = {
      requestId: event.data.requestId,
      toolName: event.data.toolName,
    };
    state.pendingByToolCallId.set(event.data.toolCallId, pending);
    const waiters = state.pendingRequestWaiters.get(event.data.toolCallId);
    if (waiters) {
      state.pendingRequestWaiters.delete(event.data.toolCallId);
      for (const waiter of waiters) waiter.resolve(pending);
    }
  }

  #forgetPendingRequest(state, requestId) {
    for (const [toolCallId, pending] of state.pendingByToolCallId) {
      if (pending.requestId === requestId) {
        state.pendingByToolCallId.delete(toolCallId);
        return;
      }
    }
  }

  async #waitForPendingRequest(state, toolCallId, signal) {
    if (signal?.aborted) throw createAbortError();
    const pending = state.pendingByToolCallId.get(toolCallId);
    if (pending) return pending;

    return new Promise((resolve, reject) => {
      const waiters = state.pendingRequestWaiters.get(toolCallId) || new Set();
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (!waiters.size) state.pendingRequestWaiters.delete(toolCallId);
      };
      const waiter = {
        reject: (error) => {
          cleanup();
          reject(error);
        },
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
      };
      const onAbort = () => waiter.reject(createAbortError());
      const timeout = setTimeout(() => {
        waiter.reject(
          new Error(
            `No pending GitHub Copilot tool call found for ${toolCallId}.`,
          ),
        );
      }, this.pendingToolWaitMs);
      waiters.add(waiter);
      state.pendingRequestWaiters.set(toolCallId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async #evictExpiredStates() {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (
        state.activeTurns === 0 &&
        state.pendingByToolCallId.size === 0 &&
        state.pendingRequestWaiters.size === 0 &&
        now - state.lastUsedAt >= this.stateIdleTtlMs
      ) {
        await this.#evictState(key, state);
      }
    }
  }

  async #enforceStateLimit(protectedKey) {
    if (this.states.size <= this.maxStates) return;
    const candidates = [...this.states.entries()]
      .filter(
        ([key, state]) =>
          key !== protectedKey &&
          state.activeTurns === 0 &&
          state.pendingByToolCallId.size === 0 &&
          state.pendingRequestWaiters.size === 0,
      )
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while (this.states.size > this.maxStates && candidates.length) {
      const [key, state] = candidates.shift();
      await this.#evictState(key, state);
    }
  }

  async #evictState(
    key,
    state,
    { abort = false, deletePersisted = false } = {},
  ) {
    for (const waiters of state.pendingRequestWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error("Copilot session state was evicted."));
      }
    }
    state.pendingRequestWaiters.clear();
    if (abort) await abortSession(state.session).catch(() => {});
    await disconnectSession(state.session).catch(() => {});
    if (deletePersisted) {
      await deleteClientSession(this.client, state.sessionId).catch(() => {});
      this.knownSessionIds.delete(state.sessionId);
    }
    this.states.delete(key);
  }
}

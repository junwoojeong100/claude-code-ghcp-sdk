import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { SessionManager } from "../src/session-manager.mjs";
import {
  emitVerificationDiagnostic,
  observeVerificationResponse,
  readVerificationModelState,
  verificationRequest,
} from "../src/verification-observer.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ids = { requestId: "request-1", responseId: "msg_response1" };
const modelId = "gpt-6-astra";
const headers = { "x-claude-code-session-id": "cli-session" };
const model = {
  id: modelId,
  capabilities: {
    supports: { reasoningEffort: true },
    supportedReasoningEfforts: ["low", "high", "xhigh"],
    limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 1000000 },
  },
};
const request = (effort = "high", selectedModel = modelId) => ({
  model: selectedModel,
  messages: [{ role: "user", content: "PRIVATE_PROMPT_안녕_café" }],
  ...(effort === null ? {} : { output_config: { effort } }),
});

class FakeSession {
  constructor(config, calls) {
    this.sessionId = config.sessionId;
    this.current = {
      modelId: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.contextTier ? { contextTier: config.contextTier } : {}),
    };
    this.calls = calls;
    this.handlers = new Map();
    this.rpc = { model: { getCurrent: async () => {
      calls.push("getCurrent");
      return this.current;
    } } };
  }
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const handlers = this.handlers.get(type);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }
  emit(type, data = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler({ type, data });
  }
  async send() {
    this.calls.push("send");
    this.emit("assistant.message", { content: "answer", toolRequests: [], outputTokens: 1 });
    this.emit("session.idle");
  }
  async setModel(selectedModel, options) {
    this.calls.push("setModel");
    this.current = { modelId: selectedModel, ...options };
  }
  async abort() { this.calls.push("abort"); }
  async disconnect() {}
}

async function fakeManager(t, { verifyObservation, models = [model], arrange, onDiagnostic } = {}) {
  const events = [];
  const calls = [];
  const client = {
    created: [],
    sessions: [],
    async start() {},
    async stop() {},
    async listModels() { return models; },
    async listSessions() { return []; },
    async deleteSession() {},
    async createSession(config) {
      calls.push("createSession");
      this.created.push(config);
      const session = new FakeSession(config, calls);
      this.sessions.push(session);
      arrange?.(session);
      return session;
    },
  };
  const manager = new SessionManager({
    baseDirectory: ".", client, verifyObservation,
    onDiagnostic: onDiagnostic ?? ((event) => events.push(event)),
  });
  await manager.start();
  t.after(() => manager.stop());
  return { manager, client, events, calls };
}

for (const verifyObservation of [undefined, false, "1"]) {
  test(`manager observation is off without literal true (${verifyObservation})`, async (t) => {
    const { manager, calls, events } = await fakeManager(t, {
      verifyObservation,
      arrange(session) {
        Object.defineProperty(session, "rpc", { get() { assert.fail("RPC must not be accessed"); } });
      },
    });
    assert.equal((await manager.execute(request(), headers, ids)).message.content, "answer");
    assert.deepEqual(calls, ["createSession", "send"]);
    assert.equal(events.some((event) => event.event.startsWith("bridge.verify_")), false);
  });
}

test("model observation runs once per request after actual effort application and before send", async (t) => {
  const { manager, client, events, calls } = await fakeManager(t, { verifyObservation: true });
  await manager.execute(request("low"), headers, ids);
  await manager.execute(request(" Ultracode "), headers, { requestId: "request-2", responseId: "msg_response2" });
  const observations = events.filter((event) => event.event === "bridge.verify_model_state");
  assert.deepEqual(calls, ["createSession", "getCurrent", "send", "setModel", "getCurrent", "send"]);
  assert.equal(client.sessions.length, 1);
  assert.deepEqual(observations, [
    {
      event: "bridge.verify_model_state", ...ids, sessionId: client.sessions[0].sessionId,
      model: modelId, requestedEffort: "low", appliedEffort: "low", requestedContextTier: "long_context",
      ok: true, current: { modelId, reasoningEffort: "low", contextTier: "long_context" },
    },
    {
      event: "bridge.verify_model_state", requestId: "request-2", responseId: "msg_response2",
      sessionId: client.sessions[0].sessionId, model: modelId,
      requestedEffort: " Ultracode ", appliedEffort: "xhigh", requestedContextTier: "long_context",
      ok: true, current: { modelId, reasoningEffort: "xhigh", contextTier: "long_context" },
    },
  ]);
});

test("model observation preserves mismatches and omits absent fields instead of inventing them", async (t) => {
  const { manager, events } = await fakeManager(t, {
    verifyObservation: true,
    arrange(session) {
      session.current = { modelId: "different-model", privateToken: "PRIVATE_TOKEN", content: "PRIVATE_OUTPUT" };
    },
  });
  const result = await manager.execute(request(), headers, ids);
  assert.equal(result.model, modelId);
  assert.equal(result.message.content, "answer");
  const observed = events.find((event) => event.event === "bridge.verify_model_state");
  assert.deepEqual(observed.current, { modelId: "different-model" });
  assert.equal(observed.ok, true, "ok is RPC success, not model/effort equality");
  assert.equal(observed.appliedEffort, "high");
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_/);
});

test("nonconfigurable models record null applied effort and absent context without setting either", async (t) => {
  const haiku = "claude-haiku-4.5";
  const { manager, client, events } = await fakeManager(t, { verifyObservation: true, models: [{ id: haiku }] });
  await manager.execute(request("high", haiku), headers, ids);
  assert.equal(Object.hasOwn(client.created[0], "reasoningEffort"), false);
  assert.equal(Object.hasOwn(client.created[0], "contextTier"), false);
  const observed = events.find((event) => event.event === "bridge.verify_model_state");
  assert.equal(observed.requestedEffort, "high");
  assert.equal(observed.appliedEffort, null);
  assert.equal(observed.requestedContextTier, null);
  assert.deepEqual(observed.current, { modelId: haiku });
});

for (const [label, arrange, category] of [
  ["RPC rejection", (session) => { session.rpc.model.getCurrent = async () => { throw new Error("PRIVATE_TOKEN PRIVATE_PROMPT"); }; }, "rpc_error"],
  ["RPC synchronous throw", (session) => { session.rpc.model.getCurrent = () => { throw new Error("PRIVATE_TOKEN"); }; }, "rpc_error"],
  ["RPC getter throw", (session) => { Object.defineProperty(session, "rpc", { get() { throw new Error("PRIVATE_TOKEN"); } }); }, "rpc_error"],
  ["missing RPC", (session) => { session.rpc = {}; }, "unavailable"],
  ["invalid response", (session) => { session.current = { modelId: { secret: "PRIVATE_TOKEN" } }; }, "invalid_response"],
]) {
  test(`${label} is diagnostic-only and preserves the model response`, async (t) => {
    const { manager, events } = await fakeManager(t, { verifyObservation: true, arrange });
    assert.equal((await manager.execute(request(), headers, ids)).message.content, "answer");
    const observed = events.find((event) => event.event === "bridge.verify_model_state");
    assert.equal(observed.ok, false);
    assert.equal(observed.current, null);
    assert.equal(observed.error, category);
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_/);
  });
}

test("RPC observation has an independent 5000ms bound and late rejection cannot alter the result", async (t) => {
  let rejectLate;
  const { manager, events, calls } = await fakeManager(t, {
    verifyObservation: true,
    arrange(session) { session.rpc.model.getCurrent = () => new Promise((_, reject) => { rejectLate = reject; }); },
  });
  const original = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    delays.push(ms);
    return original(fn, ms === 5000 ? 5 : ms, ...args);
  });
  const result = await manager.execute(request(), headers, ids);
  assert.equal(result.message.content, "answer");
  assert.ok(delays.includes(5000));
  assert.deepEqual(events.filter((event) => event.event === "bridge.verify_model_state").map((event) => event.error), ["timeout"]);
  rejectLate(new Error("PRIVATE_LATE_ERROR"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.event === "bridge.verify_model_state").length, 1);
  assert.equal(calls.includes("abort"), false);
});

test("cancellation during observation remains a real request error and never sends work", async (t) => {
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const { manager, events, calls } = await fakeManager(t, {
    verifyObservation: true,
    arrange(session) { session.rpc.model.getCurrent = () => { started(); return new Promise(() => {}); }; },
  });
  const controller = new AbortController();
  const pending = manager.execute(request(), headers, { ...ids, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await reading;
  controller.abort();
  await rejected;
  assert.equal(calls.includes("send"), false);
  assert.equal(events.find((event) => event.event === "bridge.verify_model_state").error, "aborted");
});

test("observation does not swallow production setModel or send failures", async (t) => {
  const { manager, client, events } = await fakeManager(t, { verifyObservation: true });
  await manager.execute(request("low"), headers, ids);
  const failure = new Error("production setModel failed");
  client.sessions[0].setModel = async () => { throw failure; };
  await assert.rejects(manager.execute(request("high"), headers, ids), (error) => error === failure);
  assert.equal(events.filter((event) => event.event === "bridge.verify_model_state").length, 1);
  const other = await fakeManager(t, {
    verifyObservation: true,
    arrange(session) { session.send = async () => { throw new Error("production send failed"); }; },
  });
  await assert.rejects(other.manager.execute(request(), headers, ids), /production send failed/);
});

test("diagnostic sink failures cannot alter observed model results", async (t) => {
  const { manager } = await fakeManager(t, {
    verifyObservation: true,
    onDiagnostic(event) { if (event.event === "bridge.verify_model_state") throw new Error("PRIVATE_SINK_ERROR"); },
  });
  const lines = [];
  t.mock.method(console, "error", (line) => lines.push(line));
  assert.equal((await manager.execute(request(), headers, ids)).message.content, "answer");
  assert.doesNotMatch(lines.join(""), /PRIVATE_/);
  assert.doesNotThrow(() => emitVerificationDiagnostic(() => { throw new Error("private"); }, {}));
  emitVerificationDiagnostic(async () => { throw new Error("private"); }, {});
  await new Promise((resolve) => setImmediate(resolve));
});

test("request digests retain exact Unicode and history identity but no prompt, output, credential or tool payload", () => {
  const body = {
    ...request(" HIGH "), stream: true, system: "PRIVATE_SYSTEM", metadata: { token: "PRIVATE_TOKEN" },
    messages: [
      { role: "system", content: "PRIVATE_INLINE_SYSTEM" },
      { role: "user", content: "PRIVATE_NONCE_안녕 café" },
      { role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "PRIVATE_PATH" } }] },
      { role: "user", content: [{ type: "text", text: "PRIVATE_SIBLING" }, { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }] }] },
    ],
  };
  const event = verificationRequest(body, { ...headers, authorization: "Bearer PRIVATE_AUTH", "x-api-key": "PRIVATE_API_KEY", "x-claude-code-agent-id": "PRIVATE_AGENT_ID" }, ids);
  assert.equal(event.claudeSessionId, "cli-session");
  assert.equal(event.claudeAgent, "subagent");
  assert.equal(event.effort, " HIGH ");
  assert.equal(event.messageCount, 4);
  assert.equal(event.messagesSha256, sha256(JSON.stringify(body.messages)));
  assert.deepEqual(event.userTextHashes, [sha256("PRIVATE_NONCE_안녕 café"), sha256("PRIVATE_SIBLING")]);
  assert.deepEqual(event.messageDigests, body.messages.map((message, index) => ({
    role: message.role, sha256: sha256(JSON.stringify(message)),
    textHashes: [
      ["PRIVATE_INLINE_SYSTEM"], ["PRIVATE_NONCE_안녕 café"], ["PRIVATE_OUTPUT"], ["PRIVATE_SIBLING", "PRIVATE_TOOL_RESULT"],
    ][index].map(sha256),
  })));
  assert.deepEqual(event.toolResultIds, ["tool-1"]);
  assert.deepEqual(event.toolUseIds, ["tool-1"]);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|Bearer|authorization|x-api-key/);
  const cleared = verificationRequest({ messages: [{ role: "user", content: "new conversation" }] }, {}, ids);
  assert.equal(cleared.claudeSessionId, null, "do not invent a CLI session ID");
  assert.equal(cleared.effort, null);
  assert.equal(cleared.userTextHashes.includes(event.userTextHashes[0]), false);
});

for (const [label, setup, expected] of [
  ["finish followed by close", (res) => { res.writableFinished = true; res.emit("finish"); res.emit("close"); }, { status: 200, finished: true, aborted: false }],
  ["finished close only", (res) => { res.writableFinished = true; res.emit("close"); }, { status: 200, finished: true, aborted: false }],
  ["active stream disconnect", (res) => res.emit("close"), { status: 200, finished: false, aborted: true }],
  ["disconnect before headers", (res) => { res.headersSent = false; res.emit("close"); }, { status: null, finished: false, aborted: true }],
  ["error HTTP response", (res) => { res.statusCode = 429; res.emit("finish"); res.emit("close"); }, { status: 429, finished: true, aborted: false }],
]) {
  test(`response observation records ${label} exactly once`, () => {
    const events = [];
    const res = Object.assign(new EventEmitter(), { headersSent: true, statusCode: 200, writableFinished: false });
    observeVerificationResponse(res, { ...ids, streaming: () => true }, (event) => events.push(event));
    setup(res);
    res.emit("close");
    res.emit("finish");
    assert.deepEqual(events, [{ event: "bridge.verify_response", ...ids, streaming: true, ...expected }]);
    assert.equal(res.listenerCount("finish"), 0);
    assert.equal(res.listenerCount("close"), 0);
  });
}

let serverImports = 0;
async function offlineServer(t, overrides = {}) {
  const values = {
    HOST: "127.0.0.1", PORT: "4142", BRIDGE_API_KEY: "PRIVATE_API_KEY", GHCP_MODEL: modelId,
    BRIDGE_VERIFY_OBSERVE: undefined, BRIDGE_TEST_FAULTS: undefined,
    BRIDGE_ALLOW_UNAUTHENTICATED: undefined, BRIDGE_LEASE_DIR: undefined,
    MAX_BODY_BYTES: "", MAX_REPLAY_BYTES: "", MAX_STATES: "", MAX_TOOL_RESULTS: "",
    CLEANUP_TIMEOUT_MS: "", PENDING_TOOL_WAIT_MS: "", STATE_IDLE_TTL_MS: "",
    SESSION_OPERATION_TIMEOUT_MS: "", TURN_IDLE_TIMEOUT_MS: "", TURN_MAX_DURATION_MS: "", RETIRED_IDLE_MS: "",
    ...overrides,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  const signals = new Map(["SIGINT", "SIGTERM", "SIGUSR2"].map((key) => [key, new Set(process.listeners(key))]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, listeners] of signals) {
      for (const listener of process.listeners(key)) if (!listeners.has(listener)) process.off(key, listener);
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const events = [];
  t.mock.method(console, "error", (line) => { if (typeof line === "string" && line.startsWith("{")) events.push(JSON.parse(line)); });
  let handler;
  let manager;
  t.mock.method(SessionManager.prototype, "start", async function () { manager = this; });
  t.mock.method(SessionManager.prototype, "execute", async () => assert.fail("No provider calls allowed"));
  t.mock.method(http, "createServer", (listener) => { handler = listener; return { listen() {}, close() {} }; });
  await import(`../src/server.mjs?verify-observation-test=${++serverImports}`);
  return { handler, manager, events };
}

function httpExchange(handler, body, { url = "/v1/messages", method = "POST", requestHeaders = {} } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method, url, headers: { "x-api-key": "PRIVATE_API_KEY", ...headers, ...requestHeaders },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  });
  const res = Object.assign(new EventEmitter(), {
    chunks: [], headers: {}, statusCode: 200, headersSent: false, writableFinished: false, writableEnded: false, destroyed: false,
    writeHead(status, responseHeaders) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, responseHeaders); return this; },
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { assert.equal(this.destroyed, false); this.chunks.push(chunk); return true; },
    end(body) {
      if (body !== undefined) this.body = JSON.parse(body);
      this.writableEnded = true;
      this.writableFinished = true;
      this.emit("finish");
      this.emit("close");
    },
  });
  return { req, res, done: handler(req, res) };
}

for (const value of [undefined, "0", "true"]) {
  test(`server observation and health metadata are default-off (${value})`, async (t) => {
    const { handler, manager, events } = await offlineServer(t, { BRIDGE_VERIFY_OBSERVE: value });
    assert.equal(manager.verifyObservation, false);
    t.mock.method(manager, "execute", async (_body, _headers, options) => {
      options.onReady({ model: modelId });
      options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "answer" } });
      return { model: modelId, message: { content: "answer", toolRequests: [] } };
    });
    await httpExchange(handler, { ...request(), stream: true }).done;
    const health = httpExchange(handler, {}, { url: "/health", method: "GET" });
    await health.done;
    assert.equal(Object.hasOwn(health.res.body, "timeouts"), false);
    assert.equal(events.some((event) => event.event.startsWith("bridge.verify_")), false);
  });
}

test("verifier health exposes the actual manager waits without changing defaults", async (t) => {
  const { handler, manager } = await offlineServer(t, {
    BRIDGE_VERIFY_OBSERVE: "1", TURN_IDLE_TIMEOUT_MS: "301", TURN_MAX_DURATION_MS: "900",
    SESSION_OPERATION_TIMEOUT_MS: "123", PENDING_TOOL_WAIT_MS: "234", CLEANUP_TIMEOUT_MS: "345", STATE_IDLE_TTL_MS: "456",
  });
  const health = httpExchange(handler, {}, { url: "/health", method: "GET" });
  await health.done;
  assert.equal(manager.verifyObservation, true);
  assert.deepEqual(health.res.body.timeouts, {
    turnTimeoutMs: 301, maxTurnDurationMs: 900, sessionOperationTimeoutMs: 123, pendingToolWaitMs: 234,
    abortTimeoutMs: 5000, cleanupTimeoutMs: 345, stateIdleTtlMs: 456, mcpDiscoveryTimeoutMs: 10000,
  });
  for (const [key, value] of Object.entries(health.res.body.timeouts)) {
    assert.equal(value, manager[key]);
    assert.ok(Number.isSafeInteger(value));
  }
});

test("server correlates real request, first written text progress, completion and response lifecycle", async (t) => {
  const { handler, manager, events } = await offlineServer(t, { BRIDGE_VERIFY_OBSERVE: "1" });
  let exchange;
  let actualIds;
  t.mock.method(manager, "execute", async (_body, _headers, options) => {
    actualIds = { requestId: options.requestId, responseId: options.responseId };
    options.onReady({ model: modelId });
    for (const event of [
      { type: "assistant.message_delta", data: { deltaContent: "PRIVATE_CHILD" }, agentId: "child" },
      { type: "assistant.message_delta", data: { deltaContent: "" } },
      { type: "assistant.reasoning_delta", data: { deltaContent: "PRIVATE_REASONING" } },
      { type: "assistant.tool_call_delta", data: { inputDelta: "PRIVATE_TOOL" } },
    ]) options.onEvent(event);
    assert.equal(events.some((event) => event.event === "bridge.verify_progress"), false);
    options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "PRIVATE_ANSWER" } });
    assert.match(exchange.res.chunks.join(""), /PRIVATE_ANSWER/);
    assert.equal(events.filter((event) => event.event === "bridge.verify_progress").length, 1);
    options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "_MORE" } });
    return { model: modelId, message: { content: "PRIVATE_ANSWER_MORE", toolRequests: [] } };
  });
  exchange = httpExchange(handler, { ...request(), stream: true });
  await exchange.done;
  const observed = events.filter((event) => event.event.startsWith("bridge.verify_"));
  assert.deepEqual(observed.map((event) => event.event), ["bridge.verify_request", "bridge.verify_progress", "bridge.verify_response"]);
  for (const event of [...observed, events.find((event) => event.event === "bridge.turn_completed")]) {
    assert.equal(event.requestId, actualIds.requestId);
    assert.equal(event.responseId, actualIds.responseId);
  }
  assert.deepEqual(observed[1], { event: "bridge.verify_progress", ...actualIds, kind: "assistant.message_delta" });
  assert.deepEqual(observed[2], { event: "bridge.verify_response", ...actualIds, status: 200, streaming: true, finished: true, aborted: false });
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_|authorization|x-api-key/);
});

for (const streaming of [false, true]) {
  test(`final response alone does not invent streamed readiness (stream=${streaming})`, async (t) => {
    const { handler, manager, events } = await offlineServer(t, { BRIDGE_VERIFY_OBSERVE: "1" });
    t.mock.method(manager, "execute", async () => ({ model: modelId, message: { content: "answer", toolRequests: [] } }));
    await httpExchange(handler, { ...request(), stream: streaming }).done;
    assert.equal(events.some((event) => event.event === "bridge.verify_progress"), false);
    assert.equal(events.find((event) => event.event === "bridge.verify_response").finished, true);
  });
}

test("server response status reflects the real error response rather than hardcoded success", async (t) => {
  const { handler, manager, events } = await offlineServer(t, { BRIDGE_VERIFY_OBSERVE: "1" });
  t.mock.method(manager, "execute", async () => { throw new Error("synthetic failure"); });
  const exchange = httpExchange(handler, request());
  await exchange.done;
  const response = events.find((event) => event.event === "bridge.verify_response");
  assert.equal(response.status, 500);
  assert.equal(response.finished, true);
  assert.equal(response.aborted, false);
});

test("server stream disconnect is observed once without normal completion", async (t) => {
  const { handler, manager, events } = await offlineServer(t, { BRIDGE_VERIFY_OBSERVE: "1" });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(manager, "execute", async (_body, _headers, options) => {
    options.onReady({ model: modelId });
    options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "partial" } });
    return new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      started();
    });
  });
  const exchange = httpExchange(handler, { ...request(), stream: true });
  await ready;
  exchange.res.destroyed = true;
  exchange.res.emit("close");
  await exchange.done;
  const responses = events.filter((event) => event.event === "bridge.verify_response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].finished, false);
  assert.equal(responses[0].aborted, true);
  assert.equal(responses[0].status, 200);
  assert.equal(events.some((event) => event.event === "bridge.turn_completed"), false);
  assert.equal(exchange.res.listenerCount("close"), 0);
  assert.equal(exchange.res.listenerCount("finish"), 0);
});

test("missing model RPC is an observation failure, not fabricated model state", async () => {
  assert.deepEqual(await readVerificationModelState({}), { ok: false, current: null, error: "unavailable" });
});

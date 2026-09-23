import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "../src/session-manager.mjs";
import { BridgeRequestError } from "../src/request-policy.mjs";
import { sessionError } from "../src/upstream-errors.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "server.mjs");

function runServerWith(overrides) {
  return spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRIDGE_API_KEY: "test-only",
      MAX_BODY_BYTES: "",
      MAX_REPLAY_BYTES: "",
      PORT: "",
      ...overrides,
    },
  });
}

test("rejects invalid numeric bridge settings before startup", () => {
  const invalidPort = runServerWith({ PORT: "not-a-port" });
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /PORT must be a positive integer/);

  const outOfRangePort = runServerWith({ PORT: "65536" });
  assert.equal(outOfRangePort.status, 1);
  assert.match(outOfRangePort.stderr, /PORT must be between 1 and 65535/);

  const invalidBodyLimit = runServerWith({ MAX_BODY_BYTES: "0" });
  assert.equal(invalidBodyLimit.status, 1);
  assert.match(
    invalidBodyLimit.stderr,
    /MAX_BODY_BYTES must be a positive integer/,
  );

  const invalidReplayLimit = runServerWith({ MAX_REPLAY_BYTES: "0" });
  assert.equal(invalidReplayLimit.status, 1);
  assert.match(invalidReplayLimit.stderr, /MAX_REPLAY_BYTES must be a positive integer/);
  const invalidPreparationLimit = runServerWith({ SESSION_OPERATION_TIMEOUT_MS: "0" });
  assert.equal(invalidPreparationLimit.status, 1);
  assert.match(invalidPreparationLimit.stderr, /SESSION_OPERATION_TIMEOUT_MS must be a positive integer/);
  for (const name of ["TURN_IDLE_TIMEOUT_MS", "TURN_MAX_DURATION_MS"]) {
    const invalid = runServerWith({ [name]: "0" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, new RegExp(`${name} must be a positive integer`));
    const overflow = runServerWith({ [name]: "2147483648" });
    assert.equal(overflow.status, 1);
    assert.match(overflow.stderr, new RegExp(`${name} exceeds the supported timer range`));
  }
});

let serverImports = 0;

async function offlineServer(t, overrides = {}) {
  const values = {
    HOST: "127.0.0.1", PORT: "4142", BRIDGE_API_KEY: "test-only",
    MAX_BODY_BYTES: undefined, MAX_REPLAY_BYTES: undefined,
    MAX_STATES: "", MAX_TOOL_RESULTS: "", CLEANUP_TIMEOUT_MS: "",
    PENDING_TOOL_WAIT_MS: "", STATE_IDLE_TTL_MS: "", SESSION_OPERATION_TIMEOUT_MS: "",
    TURN_IDLE_TIMEOUT_MS: "", TURN_MAX_DURATION_MS: "",
    BRIDGE_ALLOW_UNAUTHENTICATED: undefined, BRIDGE_TEST_FAULTS: undefined,
    ...overrides,
  };
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  const signals = new Map(["SIGINT", "SIGTERM"].map((name) => [name, new Set(process.listeners(name))]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [name, listeners] of signals) {
      for (const listener of process.listeners(name)) {
        if (!listeners.has(listener)) process.off(name, listener);
      }
    }
  });
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  let handler;
  let manager;
  t.mock.method(SessionManager.prototype, "start", async function () { manager = this; });
  t.mock.method(SessionManager.prototype, "execute", async () => assert.fail("No model call is allowed."));
  t.mock.method(http, "createServer", (listener) => {
    handler = listener;
    return { listen() {}, close() {} };
  });
  await import(`${pathToFileURL(serverPath).href}?offline-limit-test=${++serverImports}`);
  assert.ok(handler && manager);
  return { handler, manager };
}

test("configures a bounded SDK preparation wait independently of the model-turn timeout", async (t) => {
  const { manager } = await offlineServer(t, { SESSION_OPERATION_TIMEOUT_MS: "250" });
  assert.equal(manager.sessionOperationTimeoutMs, 250);
  assert.equal(manager.turnTimeoutMs, 300000);
  assert.equal(manager.maxTurnDurationMs, 1800000);
});

test("configures idle and hard turn deadlines independently", async (t) => {
  const { manager } = await offlineServer(t, { TURN_IDLE_TIMEOUT_MS: "40", TURN_MAX_DURATION_MS: "300" });
  assert.equal(manager.turnTimeoutMs, 40);
  assert.equal(manager.maxTurnDurationMs, 300);
});

async function tokenCountRequest(handler, chunks) {
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/v1/messages/count_tokens", headers: { "x-api-key": "test-only" },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  });
  const res = Object.assign(new EventEmitter(), {
    headers: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; this.emit("close"); },
  });
  await handler(req, res);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
  return res;
}

for (const value of [undefined, ""]) {
  test(`bridge byte limits default to exactly 256 MiB when ${value === undefined ? "unset" : "empty"}`, async (t) => {
    const { handler, manager } = await offlineServer(t, { MAX_BODY_BYTES: value, MAX_REPLAY_BYTES: value });
    assert.equal(manager.maxReplayBytes, 268_435_456);

    // Reuse real chunks and stub only the final copy to avoid allocating a 256 MiB JSON string.
    const chunk = Buffer.alloc(1024 * 1024, " ");
    const chunks = Array(256).fill(chunk);
    const concat = Buffer.concat;
    let acceptedBytes = 0;
    t.mock.method(Buffer, "concat", (parts, ...args) => {
      if (parts.length === 256 && parts.every((part) => part === chunk)) {
        acceptedBytes = parts.reduce((sum, part) => sum + part.length, 0);
        return Buffer.from("{}");
      }
      return concat(parts, ...args);
    });

    const accepted = await tokenCountRequest(handler, chunks);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["x-ghcp-token-count-method"], "estimated");
    assert.equal(acceptedBytes, 268_435_456);
    const rejected = await tokenCountRequest(handler, [...chunks, Buffer.from(" ")]);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.message, "Request body exceeds MAX_BODY_BYTES.");
  });
}

async function messageRequest(
  handler,
  value,
  url = "/v1/messages",
  onRequest,
  { method = "POST", headers = { "x-api-key": "test-only" } } = {},
) {
  const req = Object.assign(new EventEmitter(), {
    method, url, headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)); },
  });
  const res = Object.assign(new EventEmitter(), {
    headers: {}, chunks: [],
    writeHead(status, headers) {
      this.status = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
    },
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.chunks.push(chunk); },
    end(body) {
      if (body !== undefined) this.body = JSON.parse(body);
      this.writableEnded = true;
      this.emit("close");
    },
  });
  const response = handler(req, res);
  onRequest?.(req, res);
  await response;
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
  return res;
}

function sseData(response) {
  return response.chunks.join("").split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

// The bridge's diagnostics are the JSON lines it writes to stderr.
function captureDiagnostics(t) {
  const events = [];
  t.mock.method(console, "error", (line) => {
    if (typeof line === "string" && line.startsWith("{")) events.push(JSON.parse(line));
  });
  return events;
}

test("model requests receive server-generated request and response correlation IDs", async (t) => {
  const { handler, manager } = await offlineServer(t);
  let options;
  t.mock.method(manager, "execute", async (_body, _headers, value) => {
    options = value;
    return { model: "gpt-5.6-sol", message: { content: "ok", toolRequests: [] } };
  });

  const response = await messageRequest(handler, {
    model: "gpt-5.6-sol", messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    requestId: "PRIVATE_UNTRUSTED_ID",
  });
  assert.match(options.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(options.responseId, `msg_${options.requestId.replaceAll("-", "")}`);
  assert.equal(response.body.id, options.responseId);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
});

for (const [stream, started] of [[false, false], [true, false], [true, true]]) {
  test(`context overflow is recoverable with stream=${stream} and output-started=${started}`, async (t) => {
    const { handler, manager } = await offlineServer(t);
    t.mock.method(manager, "execute", async (_body, _headers, options) => {
      options.onReady({ model: "gpt-6-astra" });
      if (started) options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "partial" } });
      throw new BridgeRequestError("prompt is too long: context budget exceeded");
    });
    const response = await messageRequest(handler, {
      stream, model: "gpt-6-astra", messages: [{ role: "user", content: "synthetic context" }],
    });
    const body = started
      ? response.chunks.join("").split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).at(-1)
      : response.body;
    assert.equal(body.error.type, "invalid_request_error");
    assert.match(body.error.message, /prompt is too long/);
    if (!started) {
      assert.equal(response.status, 400);
      assert.equal(response.chunks.length, 0);
    }
  });
}

test("root reasoning activity opens a ping-capable stream without exposing reasoning text", async (t) => {
  const { handler, manager } = await offlineServer(t);
  let response;
  t.mock.method(manager, "execute", async (_body, _headers, options) => {
    options.onReady({ model: "gpt-6-astra" });
    assert.notEqual(response.headersSent, true);
    options.onEvent({ type: "assistant.reasoning_delta", data: { deltaContent: "PRIVATE_REASONING" } });
    assert.equal(response.headers["content-type"], "text/event-stream");
    return { model: "gpt-6-astra", message: { content: "answer", toolRequests: [] } };
  });
  await messageRequest(handler, { stream: true, model: "gpt-6-astra", messages: [] },
    "/v1/messages", (_req, res) => { response = res; });
  assert.doesNotMatch(response.chunks.join(""), /PRIVATE_REASONING/);
  assert.match(response.chunks.join(""), /event: message_stop/);
});

test("measured zero usage is preserved while missing usage keeps the estimate", async (t) => {
  const { handler, manager } = await offlineServer(t);
  let usage;
  t.mock.method(manager, "execute", async () => ({
    model: "gpt-5.6-sol",
    message: { content: "ok", toolRequests: [], outputTokens: 7 },
    usage,
  }));
  const body = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }] };
  usage = { inputTokens: 0, outputTokens: 0 };
  const measured = await messageRequest(handler, body);
  assert.equal(measured.body.usage.input_tokens, 0);
  assert.equal(measured.body.usage.output_tokens, 0);
  usage = { inputTokens: 230000, cacheReadTokens: 210000, cacheWriteTokens: 19997, outputTokens: 7 };
  const cached = await messageRequest(handler, body);
  assert.equal(cached.body.usage.input_tokens, 3);
  assert.equal(
    cached.body.usage.input_tokens + cached.body.usage.cache_read_input_tokens +
      cached.body.usage.cache_creation_input_tokens,
    230000,
  );
  usage = null;
  const estimated = await messageRequest(handler, body);
  assert.ok(estimated.body.usage.input_tokens > 0);
  assert.equal(estimated.body.usage.output_tokens, 7);
});

test("a disconnected model request aborts its correlated manager call", async (t) => {
  const { handler, manager } = await offlineServer(t);
  let started;
  const executing = new Promise((resolve) => { started = resolve; });
  let options;
  t.mock.method(manager, "execute", (_body, _headers, value) => {
    options = value;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("The Claude Code request was aborted."), { name: "AbortError" }));
      }, { once: true });
      started();
    });
  });
  let socket;
  const response = messageRequest(handler, {
    model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }],
  }, "/v1/messages", (_req, res) => { socket = res; });
  await executing;
  socket.emit("close");
  const result = await response;
  assert.equal(options.signal.aborted, true);
  assert.equal(options.responseId, `msg_${options.requestId.replaceAll("-", "")}`);
  assert.equal(result.status, 499);
  assert.equal(result.body.error.type, "client_closed_request");
  assert.equal(socket.listenerCount("close"), 0);
});

for (const streaming of [false, true]) {
  test(`disconnects during body reading never start ${streaming ? "streaming" : "nonstreaming"} inference`, async (t) => {
    const { handler, manager } = await offlineServer(t);
    const execute = t.mock.method(manager, "execute", async () => ({
      model: "gpt-5.6-sol", message: { content: "must not run", toolRequests: [] },
    }));
    for (const disconnect of [
      (_req, res) => res.emit("close"),
      (req) => req.emit("aborted"),
      (_req, res) => { res.destroyed = true; },
      (req) => { req.aborted = true; },
    ]) {
      // The callback runs while the async body iterator is suspended. Test both
      // events and persisted flags so neither listener timing nor snapshots alone suffice.
      const response = await messageRequest(handler, {
        stream: streaming, messages: [{ role: "user", content: "hello" }],
      }, "/v1/messages", disconnect);
      assert.equal(execute.mock.callCount(), 0);
      assert.notEqual(response.headers["content-type"], "text/event-stream");
      assert.equal(response.chunks.length, 0);
      if (response.destroyed) assert.equal(response.status, undefined);
    }
  });

  test(`normal request and response close do not abort ${streaming ? "streaming" : "nonstreaming"} inference`, async (t) => {
    const { handler, manager } = await offlineServer(t);
    let signal;
    t.mock.method(manager, "execute", async (_body, _headers, options) => {
      signal = options.signal;
      return { model: "gpt-5.6-sol", message: { content: "ok", toolRequests: [] } };
    });
    const response = await messageRequest(handler, {
      stream: streaming, messages: [{ role: "user", content: "hello" }],
    }, "/v1/messages", (req) => { req.complete = true; req.emit("close"); });
    assert.equal(signal.aborted, false);
    assert.equal(response.status, 200);
    if (streaming) assert.match(response.chunks.join(""), /event: message_stop/);
    else assert.equal(response.body.content[0].text, "ok");
  });
}

test("request-body failures clean lifecycle listeners without writing to a disconnected response", async (t) => {
  const { handler } = await offlineServer(t);
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/v1/messages", headers: { "x-api-key": "test-only" },
    async *[Symbol.asyncIterator]() { throw new Error("upload interrupted"); },
  });
  const res = Object.assign(new EventEmitter(), {
    writeHead() { assert.fail("Cannot write to a disconnected response."); },
  });
  const handling = handler(req, res);
  res.destroyed = true;
  res.emit("close");
  await handling;
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

// Capture the real constructor before offlineServer replaces it; this only opens
// an ephemeral loopback listener and never starts the SDK or a live model.
const createHttpServer = http.createServer;

async function socketRequest(t, handler, { body, incomplete = false }) {
  let received;
  const incoming = new Promise((resolve) => { received = resolve; });
  const server = createHttpServer((req, res) => {
    const requestClosed = new Promise((resolve) => req.once("close", resolve));
    received({ req, res, requestClosed, handled: handler(req, res) });
  });
  let client;
  t.after(async () => {
    client?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const payload = JSON.stringify(body);
  client = http.request({
    host: "127.0.0.1", port: server.address().port, method: "POST", path: "/v1/messages",
    headers: { "x-api-key": "test-only", "content-length": Buffer.byteLength(payload) + (incomplete ? 1 : 0) },
  }, (res) => res.resume());
  client.on("error", () => {}); // Client destruction intentionally resets the connection.
  if (incomplete) client.write(payload);
  else client.end(payload);
  return { client, ...await incoming };
}

test("an actual socket disconnect during upload skips inference and cleans listeners", { timeout: 5000 }, async (t) => {
  const { handler, manager } = await offlineServer(t);
  const execute = t.mock.method(manager, "execute", async () => assert.fail("No inference after disconnect."));
  const { client, req, res, handled } = await socketRequest(t, handler, {
    body: { messages: [{ role: "user", content: "hello" }] }, incomplete: true,
  });
  client.destroy();
  await handled;
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(req.aborted, true);
  assert.equal(res.destroyed, true);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

for (const streaming of [false, true]) {
  test(`an actual socket disconnect after upload aborts ${streaming ? "streaming" : "nonstreaming"} inference`, { timeout: 5000 }, async (t) => {
    const { handler, manager } = await offlineServer(t);
    let started;
    const executing = new Promise((resolve) => { started = resolve; });
    t.mock.method(manager, "execute", (_body, _headers, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("client disconnected"), { name: "AbortError" }));
      }, { once: true });
      started(signal);
    }));
    const { client, req, res, handled, requestClosed } = await socketRequest(t, handler, {
      body: { stream: streaming, messages: [{ role: "user", content: "hello" }] },
    });
    const signal = await executing;
    await requestClosed;
    assert.equal(req.complete, true);
    assert.equal(req.aborted, false);
    assert.equal(signal.aborted, false, "A normally completed upload is not a disconnect.");
    client.destroy();
    await handled;
    assert.equal(signal.aborted, true);
    assert.equal(res.destroyed, true);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
  });
}

test("invalid request shapes return 400 before SSE and leave the bridge usable", async (t) => {
  const { handler, manager } = await offlineServer(t);
  for (const url of ["/v1/messages", "/v1/messages/count_tokens"]) {
    for (const body of [
      null, [], true, 42, "hello",
      { stream: "true" }, { messages: {} }, { messages: [null] },
      { messages: [{ role: "user", content: 12 }] },
      { messages: [{ role: "user", content: [null] }] },
      { tools: {} }, { tools: [null] }, { tools: [{ name: 5 }] },
      { system: {} }, { output_config: [] },
      { stream: true, messages: "not-an-array" },
    ]) {
      const rejected = await messageRequest(handler, body, url);
      assert.equal(rejected.status, 400, `${url}: ${JSON.stringify(body)}`);
      assert.equal(rejected.body.error.type, "invalid_request_error");
      assert.match(rejected.headers["content-type"], /application\/json/);
    }
  }
  const health = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler({ method: "GET", url: "/health", headers: {} }, health);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  t.mock.method(manager, "execute", async () => ({
    model: "gpt-5.6-sol", message: { content: "still alive", toolRequests: [], outputTokens: 2 },
  }));
  const normal = await messageRequest(handler, {
    model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }],
    future_gateway_field: { enabled: true },
  });
  assert.equal(normal.status, 200);
  assert.equal(normal.body.content[0].text, "still alive");
});

test("/health advertises the same controls and ignored fields the bridge logs", async (t) => {
  const { handler } = await offlineServer(t);
  const health = await messageRequest(handler, {}, "/health", undefined, { method: "GET", headers: {} });
  assert.equal(health.status, 200);
  // The lists test/request-policy.test.mjs sees in bridge.degraded_controls.
  assert.deepEqual(health.body.capabilities.unsupportedNativeControls, [
    "temperature", "top_p", "max_tokens", "stop_sequences",
  ]);
  assert.deepEqual(health.body.capabilities.ignoredRequestFields, [
    "thinking", "top_k", "metadata", "service_tier", "speed", "container",
    "mcp_servers", "context_management", "output_config.format",
    "output_config.task_budget", "tool_choice.disable_parallel_tool_use",
  ]);
});

test("explicit body and replay byte limits override the defaults", async (t) => {
  const { handler, manager } = await offlineServer(t, { MAX_BODY_BYTES: "32", MAX_REPLAY_BYTES: "17" });
  assert.equal(manager.maxReplayBytes, 17);
  const payload = (size) => Buffer.from(JSON.stringify({ padding: "x".repeat(size) }));
  assert.equal(payload(18).length, 32);
  assert.equal((await tokenCountRequest(handler, [payload(18)])).status, 200);
  const rejected = await tokenCountRequest(handler, [payload(19)]);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.message, "Request body exceeds MAX_BODY_BYTES.");
});

const PRIVATE_UPSTREAM = "PRIVATE_UPSTREAM_TEXT";
for (const [label, error, expected] of [
  ["a rate limit", sessionError({
    errorType: "rate_limit", errorCode: "user_model_rate_limited", eligibleForAutoSwitch: false,
    message: `${PRIVATE_UPSTREAM} rate limited`, statusCode: 429, providerCallId: "F00D:1",
  }), { status: 429, type: "rate_limit_error", retryAfterSeconds: null }],
  ["a rate limit with a known reset", sessionError({
    errorType: "rate_limit", message: `${PRIVATE_UPSTREAM} rate limited`, statusCode: 429,
  }, { retryAfterSeconds: 2.4 }), { status: 429, type: "rate_limit_error", retryAfterSeconds: 3 }],
  ["an exhausted quota", sessionError({
    errorType: "quota", errorCode: "quota_exceeded", message: `${PRIVATE_UPSTREAM} out of credits`,
  }), { status: 429, type: "rate_limit_error", retryAfterSeconds: null }],
  ["an upstream 502", sessionError({
    errorType: "query", message: `${PRIVATE_UPSTREAM} Bad Gateway`, statusCode: 502,
  }), { status: 529, type: "overloaded_error", retryAfterSeconds: null }],
  ["an unclassified SDK error", sessionError({
    errorType: "authorization", message: `${PRIVATE_UPSTREAM} denied`, statusCode: 403,
  }), { status: 500, type: "api_error", retryAfterSeconds: null }],
  ["an invalid request", new BridgeRequestError(`${PRIVATE_UPSTREAM} bad shape`),
    { status: 400, type: "invalid_request_error", retryAfterSeconds: null }],
]) {
  for (const [stream, started] of [[false, false], [true, false], [true, true]]) {
    test(`${label} leaves as ${expected.status} ${expected.type} with stream=${stream} and output-started=${started}`, async (t) => {
      const { handler, manager } = await offlineServer(t);
      const diagnostics = captureDiagnostics(t);
      t.mock.method(manager, "execute", async (_body, _headers, options) => {
        options.onReady({ model: "gpt-5.6-sol" });
        if (started) options.onEvent({ type: "assistant.message_delta", data: { deltaContent: "partial" } });
        throw error;
      });
      const response = await messageRequest(handler, {
        stream, model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }],
      });
      const envelope = started ? sseData(response).at(-1) : response.body;
      assert.deepEqual(envelope, { type: "error", error: { type: expected.type, message: error.message } });
      if (!started) {
        assert.equal(response.status, expected.status);
        assert.equal(response.chunks.length, 0);
        assert.equal(
          response.headers["retry-after"],
          expected.retryAfterSeconds == null ? undefined : String(expected.retryAfterSeconds),
        );
      }
      const failures = diagnostics.filter((event) => event.event === "bridge.request_failed");
      assert.equal(failures.length, 1);
      assert.match(failures[0].requestId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(failures[0], {
        event: "bridge.request_failed", requestId: failures[0].requestId, status: expected.status,
        errorType: expected.type, retryAfterSeconds: expected.retryAfterSeconds, streaming: stream, headersSent: started,
      });
      assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(PRIVATE_UPSTREAM));
    });
  }
}

test("malformed BRIDGE_TEST_FAULTS stops startup", () => {
  for (const value of ["rate_limit", "rate_limit:0", "timeout:1", "rate_limit:1,rate_limit:2"]) {
    const result = runServerWith({ BRIDGE_TEST_FAULTS: value });
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /BRIDGE_TEST_FAULTS/, value);
  }
});

test("BRIDGE_TEST_FAULTS fails agent turns in order through the real error mapping", async (t) => {
  const { handler, manager } = await offlineServer(t, {
    BRIDGE_TEST_FAULTS: "rate_limit:2,overloaded:1,context_limit:1",
  });
  const diagnostics = captureDiagnostics(t);
  t.mock.method(manager, "execute", async () => ({
    model: "gpt-5.6-sol", message: { content: "ok", toolRequests: [] },
  }));
  const contextLimit = t.mock.method(manager, "contextLimitErrorFor");
  const headers = { "x-api-key": "test-only", "x-claude-code-session-id": "fault-session" };
  const send = (value, url = "/v1/messages") => messageRequest(handler, value, url, undefined, { headers });
  const sideCall = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Write a title." }] };
  const agentTurn = (stream = false) => ({
    ...sideCall, stream, tools: [{ name: "Read", input_schema: { type: "object" } }],
  });

  // Title and summary calls declare no tools, and token counting never
  // reaches the model, so none of them spends a fault.
  assert.equal((await send(sideCall)).status, 200);
  assert.equal((await send({ ...sideCall, tools: [] })).status, 200);
  assert.equal((await send(agentTurn(), "/v1/messages/count_tokens")).status, 200);

  const expected = [
    [false, 429, "rate_limit_error", "1"],
    [true, 429, "rate_limit_error", "1"],
    [false, 529, "overloaded_error", undefined],
    [true, 400, "invalid_request_error", undefined],
  ];
  const failed = [];
  for (const [stream, status, type, retryAfter] of expected) {
    const response = await send(agentTurn(stream));
    assert.equal(response.status, status);
    assert.equal(response.body.error.type, type);
    assert.equal(response.headers["retry-after"], retryAfter);
    assert.equal(response.chunks.length, 0);
    failed.push(response);
  }
  assert.equal(
    failed[3].body.error.message,
    "prompt is too long: GitHub Copilot would reduce conversation history. Compact the conversation before retrying.",
  );
  assert.equal(contextLimit.mock.callCount(), 1);
  assert.equal(contextLimit.mock.calls[0].arguments[0], headers);
  assert.equal((await send(agentTurn())).status, 200);
  assert.equal(manager.execute.mock.callCount(), 3);

  const lifecycle = diagnostics.filter((event) =>
    ["bridge.test_fault_injected", "bridge.request_failed"].includes(event.event));
  assert.deepEqual(lifecycle.map((event) => event.event), Array(4).fill(["bridge.test_fault_injected", "bridge.request_failed"]).flat());
  const injected = lifecycle.filter((event) => event.event === "bridge.test_fault_injected");
  assert.deepEqual(injected.map(({ kind, remaining }) => [kind, remaining]), [
    ["rate_limit", 1], ["rate_limit", 0], ["overloaded", 0], ["context_limit", 0],
  ]);
  for (const [index, fault] of injected.entries()) {
    const failure = lifecycle[index * 2 + 1];
    assert.deepEqual(Object.keys(fault), ["event", "requestId", "kind", "remaining"]);
    assert.equal(failure.requestId, fault.requestId);
    assert.deepEqual(
      [failure.status, failure.errorType, failure.retryAfterSeconds, failure.streaming, failure.headersSent],
      [expected[index][1], expected[index][2], expected[index][3] ? 1 : null, expected[index][0], false],
    );
  }
});

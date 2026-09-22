import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "../src/session-manager.mjs";

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
});

let serverImports = 0;

async function offlineServer(t, overrides = {}) {
  const values = {
    HOST: "127.0.0.1", PORT: "4142", BRIDGE_API_KEY: "test-only",
    MAX_BODY_BYTES: undefined, MAX_REPLAY_BYTES: undefined,
    MAX_STATES: "", MAX_TOOL_RESULTS: "", CLEANUP_TIMEOUT_MS: "",
    PENDING_TOOL_WAIT_MS: "", STATE_IDLE_TTL_MS: "", SESSION_OPERATION_TIMEOUT_MS: "",
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
});

async function tokenCountRequest(handler, chunks) {
  const req = {
    method: "POST", url: "/v1/messages/count_tokens", headers: { "x-api-key": "test-only" },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
  const res = {
    headers: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler(req, res);
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

async function messageRequest(handler, value, url = "/v1/messages", onRequest) {
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url, headers: { "x-api-key": "test-only" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)); },
  });
  const res = Object.assign(new EventEmitter(), {
    headers: {},
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; },
  });
  const response = handler(req, res);
  onRequest?.(req, res);
  await response;
  return res;
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

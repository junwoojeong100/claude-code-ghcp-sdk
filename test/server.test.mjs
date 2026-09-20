import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
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
});

let serverImports = 0;

async function offlineServer(t, overrides = {}) {
  const values = {
    HOST: "127.0.0.1", PORT: "4142", BRIDGE_API_KEY: "test-only",
    MAX_BODY_BYTES: undefined, MAX_REPLAY_BYTES: undefined,
    MAX_STATES: "", MAX_TOOL_RESULTS: "", CLEANUP_TIMEOUT_MS: "",
    PENDING_TOOL_WAIT_MS: "", STATE_IDLE_TTL_MS: "",
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

test("explicit body and replay byte limits override the defaults", async (t) => {
  const { handler, manager } = await offlineServer(t, { MAX_BODY_BYTES: "32", MAX_REPLAY_BYTES: "17" });
  assert.equal(manager.maxReplayBytes, 17);
  assert.equal((await tokenCountRequest(handler, [Buffer.from(JSON.stringify("x".repeat(30)))])).status, 200);
  const rejected = await tokenCountRequest(handler, [Buffer.from(JSON.stringify("x".repeat(31)))]);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.message, "Request body exceeds MAX_BODY_BYTES.");
});

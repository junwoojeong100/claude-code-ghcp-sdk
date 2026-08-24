import http from "node:http";
import { randomUUID } from "node:crypto";

import {
  AnthropicSseStream,
  estimateTokens,
  startSse,
  writeJsonMessage,
  writeSseError,
} from "./anthropic.mjs";
import { resolveCopilotHome } from "./copilot-home.mjs";
import {
  gatewayModelEntries,
  ModelUnavailableError,
  ReasoningEffortUnavailableError,
} from "./model-map.mjs";
import { BridgeRequestError } from "./request-policy.mjs";
import { SessionManager } from "./session-manager.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MESSAGES_PATH = "/v1/messages";
const TOKEN_COUNT_PATH = "/v1/messages/count_tokens";
const MESSAGE_PATHS = new Set([MESSAGES_PATH, TOKEN_COUNT_PATH]);

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const host = process.env.HOST || "127.0.0.1";
const port = readPositiveIntegerEnv("PORT", 4142);
const apiKey = process.env.BRIDGE_API_KEY;
const instanceId = process.env.BRIDGE_INSTANCE_ID || null;
const preferredModel = process.env.GHCP_MODEL || "claude-sonnet-5";
const copilotHome = resolveCopilotHome(process.env.COPILOT_HOME);
const logLevel = process.env.LOG_LEVEL || "error";
const maxBodyBytes = readPositiveIntegerEnv(
  "MAX_BODY_BYTES",
  25 * 1024 * 1024,
);
const cleanupTimeoutMs = readPositiveIntegerEnv(
  "CLEANUP_TIMEOUT_MS",
  5_000,
);
const maxReplayBytes = readPositiveIntegerEnv(
  "MAX_REPLAY_BYTES",
  256 * 1024,
);
const maxStates = readPositiveIntegerEnv("MAX_STATES", 64);
const maxToolResults = readPositiveIntegerEnv("MAX_TOOL_RESULTS", 32);
const pendingToolWaitMs = readPositiveIntegerEnv(
  "PENDING_TOOL_WAIT_MS",
  10_000,
);
const stateIdleTtlMs = readPositiveIntegerEnv(
  "STATE_IDLE_TTL_MS",
  30 * 60 * 1000,
);

if (
  !LOOPBACK_HOSTS.has(host) &&
  process.env.ALLOW_NON_LOOPBACK !== "1"
) {
  throw new Error("The bridge only binds to loopback unless ALLOW_NON_LOOPBACK=1 is set.");
}
if (port > 65_535) {
  throw new Error("PORT must be between 1 and 65535.");
}
if (!apiKey && process.env.BRIDGE_ALLOW_UNAUTHENTICATED !== "1") {
  throw new Error("BRIDGE_API_KEY is required.");
}

const manager = new SessionManager({
  baseDirectory: copilotHome,
  preferredModel,
  logLevel,
  cleanupTimeoutMs,
  maxReplayBytes,
  maxStates,
  maxToolResults,
  onDiagnostic: (event) => {
    console.error(JSON.stringify(event));
  },
  pendingToolWaitMs,
  stateIdleTtlMs,
});
await manager.start();

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeApiError(res, status, type, message) {
  writeJson(res, status, {
    type: "error",
    error: { type, message },
  });
}

function isAuthenticated(req) {
  if (!apiKey) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return bearer === apiKey || req.headers["x-api-key"] === apiKey;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body exceeds MAX_BODY_BYTES.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const requestId = randomUUID();
  // Only the path and query matter; a neutral base also works for an IPv6 bind host.
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const requestPath = requestUrl.pathname;

  if (req.method === "HEAD" && requestPath === "/api/hello") {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "GET" && requestPath === "/health") {
    writeJson(res, 200, {
      capabilities: {
        actualUsageAfterCall: true,
        backgroundBridge: true,
        mcpToolSearch: "full-schema-fallback",
        structuredOutput: "claude-code-validator",
        tokenCounting: "estimated-preflight",
        unsupportedNativeControls: [
          "temperature",
          "top_p",
          "max_tokens",
          "stop_sequences",
        ],
      },
      ok: true,
      instanceId,
      preferredModel,
      modelCount: manager.listModels().length,
    });
    return;
  }
  if (!isAuthenticated(req)) {
    writeApiError(
      res,
      401,
      "authentication_error",
      "Invalid bridge credential.",
    );
    return;
  }
  if (req.method === "GET" && requestPath === "/v1/models") {
    const includeAll = requestUrl.searchParams.get("all") === "true";
    writeJson(res, 200, {
      object: "list",
      data: includeAll
        ? manager.listModels().map((model) => ({
            id: model.id,
            object: "model",
            owned_by: "github-copilot",
          }))
        : gatewayModelEntries(manager.listModels()),
    });
    return;
  }
  if (
    req.method !== "POST" ||
    !MESSAGE_PATHS.has(requestPath)
  ) {
    writeApiError(res, 404, "not_found_error", "Not found.");
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    writeApiError(res, 400, "invalid_request_error", error.message);
    return;
  }

  if (requestPath === TOKEN_COUNT_PATH) {
    res.setHeader("x-ghcp-token-count-method", "estimated");
    writeJson(res, 200, { input_tokens: estimateTokens(body) });
    return;
  }

  const streaming = Boolean(body.stream);
  const abortController = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  let keepAlive;
  let stream;
  const responseId = `msg_${requestId.replaceAll("-", "")}`;
  const inputTokens = estimateTokens(body);
  if (streaming) {
    startSse(res);
    keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
    stream = new AnthropicSseStream(res, {
      id: responseId,
      inputTokens,
    });
  }

  try {
    const result = await manager.execute(body, req.headers, {
      onReady: ({ model }) => stream?.start(model),
      onEvent: (event) => stream?.handleSdkEvent(event),
      signal: abortController.signal,
    });
    clearInterval(keepAlive);
    const response = {
      id: responseId,
      model: result.model,
      message: result.message,
      inputTokens: result.usage?.inputTokens || inputTokens,
      usage: result.usage,
    };

    if (streaming) stream.finish(response);
    else writeJsonMessage(res, response);
  } catch (error) {
    clearInterval(keepAlive);
    if (error.name === "AbortError") {
      if (!res.destroyed && !res.headersSent) {
        writeApiError(
          res,
          499,
          "client_closed_request",
          "The client closed the request.",
        );
      }
      return;
    }
    console.error(`[${requestId}] ${error.name}: ${error.message}`);
    if (res.destroyed) return;
    if (streaming) {
      writeSseError(res, error);
      return;
    }
    const invalidRequest =
      error instanceof BridgeRequestError ||
      error instanceof ModelUnavailableError ||
      error instanceof ReasoningEffortUnavailableError;
    writeApiError(
      res,
      invalidRequest ? 400 : 500,
      invalidRequest ? "invalid_request_error" : "api_error",
      error.message,
    );
  } finally {
    req.removeListener("aborted", abortRequest);
    res.removeListener("close", abortRequest);
  }
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: "bridge.started",
      address: `http://${host}:${port}`,
      preferredModel,
      models: manager.listModels().length,
    }),
  );
});

async function shutdown() {
  server.close();
  await manager.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

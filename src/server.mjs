import http from "node:http";
import { randomUUID } from "node:crypto";

import {
  AnthropicSseStream,
  anthropicStopReason,
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
import {
  BridgeRequestError,
  DEGRADED_CONTROLS,
  IGNORED_FIELDS,
} from "./request-policy.mjs";
import { SessionManager } from "./session-manager.mjs";
import {
  parseTestFaults,
  testFaultError,
  UpstreamError,
} from "./upstream-errors.mjs";

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
  256 * 1024 * 1024,
);
const cleanupTimeoutMs = readPositiveIntegerEnv(
  "CLEANUP_TIMEOUT_MS",
  5_000,
);
const maxReplayBytes = readPositiveIntegerEnv(
  "MAX_REPLAY_BYTES",
  256 * 1024 * 1024,
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
const sessionOperationTimeoutMs = readPositiveIntegerEnv(
  "SESSION_OPERATION_TIMEOUT_MS",
  60_000,
);
const turnTimeoutMs = readPositiveIntegerEnv("TURN_IDLE_TIMEOUT_MS", 300_000);
const maxTurnDurationMs = readPositiveIntegerEnv("TURN_MAX_DURATION_MS", 30 * 60_000);
for (const [name, value] of [["TURN_IDLE_TIMEOUT_MS", turnTimeoutMs], ["TURN_MAX_DURATION_MS", maxTurnDurationMs]]) {
  if (value > 2_147_483_647) throw new Error(`${name} exceeds the supported timer range.`);
}

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
// Verification seam, not a feature. BRIDGE_TEST_FAULTS="rate_limit:1,overloaded:1"
// fails that many agent turns of each kind, in the listed order, before they
// reach Copilot. Only requests that declare tools count: Claude Code's title
// and summary side calls declare none. Each failure is the error a real
// upstream failure of that kind raises, so the status mapping below runs as
// it would in production. Unset or empty, nothing changes.
const testFaults = parseTestFaults(process.env.BRIDGE_TEST_FAULTS);

// One JSON object per stderr line, whatever LOG_LEVEL says. A verification
// harness parses these, so event and field names are a contract, and none
// may carry prompt or output content.
function emitDiagnostic(event) {
  console.error(JSON.stringify(event));
}

function reportRequestFailure(requestId, { status, type, retryAfterSeconds = null }, { streaming = false, headersSent = false } = {}) {
  emitDiagnostic({
    event: "bridge.request_failed",
    requestId,
    status,
    errorType: type,
    retryAfterSeconds,
    streaming,
    headersSent,
  });
}

const manager = new SessionManager({
  baseDirectory: copilotHome,
  preferredModel,
  logLevel,
  cleanupTimeoutMs,
  maxReplayBytes,
  maxStates,
  maxToolResults,
  onDiagnostic: emitDiagnostic,
  pendingToolWaitMs,
  sessionOperationTimeoutMs,
  turnTimeoutMs,
  maxTurnDurationMs,
  stateIdleTtlMs,
});
await manager.start();

function writeJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeApiError(res, status, type, message, headers) {
  writeJson(res, status, {
    type: "error",
    error: { type, message },
  }, headers);
}

function isAuthenticated(req) {
  if (!apiKey) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return bearer === apiKey || req.headers["x-api-key"] === apiKey;
}

// Claude Code retries 429 rate_limit_error and 529 overloaded_error, so those
// keep the status an UpstreamError carries. Everything else is 400 when the
// request itself is at fault and 500 otherwise.
function errorResponse(error) {
  if (error instanceof UpstreamError) {
    return {
      status: error.status,
      type: error.type,
      retryAfterSeconds: error.retryAfterSeconds == null
        ? null
        : Math.max(0, Math.ceil(error.retryAfterSeconds)),
    };
  }
  const invalidRequest =
    error instanceof BridgeRequestError ||
    error instanceof ModelUnavailableError ||
    error instanceof ReasoningEffortUnavailableError;
  return invalidRequest
    ? { status: 400, type: "invalid_request_error", retryAfterSeconds: null }
    : { status: 500, type: "api_error", retryAfterSeconds: null };
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

function validateBody(body) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const requireShape = (condition, message) => {
    if (!condition) throw new BridgeRequestError(message);
  };
  const content = (value, field) => {
    requireShape(typeof value === "string" || Array.isArray(value), `${field} must be a string or an array of content blocks.`);
    if (!Array.isArray(value)) return;
    for (const block of value) {
      requireShape(object(block) && typeof block.type === "string", `${field} must contain content block objects.`);
      if (block.type === "text") {
        requireShape(typeof block.text === "string", `${field} text blocks must contain text.`);
      }
      if (block.type === "tool_result") {
        requireShape(typeof block.tool_use_id === "string", "tool_result must contain a tool_use_id.");
        if (block.content !== undefined) content(block.content, "tool_result.content");
      }
    }
  };

  requireShape(object(body), "Request body must be a JSON object.");
  if (body.stream !== undefined) requireShape(typeof body.stream === "boolean", "stream must be a boolean.");
  if (body.model !== undefined) requireShape(typeof body.model === "string", "model must be a string.");
  if (body.messages !== undefined) {
    requireShape(Array.isArray(body.messages), "messages must be an array.");
    for (const message of body.messages) {
      requireShape(object(message) && typeof message.role === "string", "messages must contain message objects with a role.");
      content(message.content, "message.content");
    }
  }
  if (body.system !== undefined) content(body.system, "system");
  if (body.tools !== undefined) {
    requireShape(Array.isArray(body.tools), "tools must be an array.");
    for (const tool of body.tools) {
      requireShape(object(tool) && typeof tool.name === "string", "tools must contain tool objects with a name.");
      if (tool.input_schema !== undefined) requireShape(object(tool.input_schema), "tool.input_schema must be an object.");
    }
  }
  if (body.tool_choice !== undefined) requireShape(object(body.tool_choice), "tool_choice must be an object.");
  if (body.output_config !== undefined) requireShape(object(body.output_config), "output_config must be an object.");
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
        unsupportedNativeControls: DEGRADED_CONTROLS,
        // Accepted and ignored; logged as ignoredFields beside the controls.
        ignoredRequestFields: IGNORED_FIELDS,
      },
      ok: true,
      instanceId,
      preferredModel,
      modelCount: manager.listModels().length,
    });
    return;
  }
  if (!isAuthenticated(req)) {
    if (requestPath === MESSAGES_PATH) {
      reportRequestFailure(requestId, { status: 401, type: "authentication_error" });
    }
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

  const abortController = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded) abortController.abort();
  };
  // Listen before awaiting the upload: a close during body reading must not
  // become abandoned inference queued after the client has already gone away.
  // IncomingMessage's normal "close" means the upload finished, not cancellation.
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  let keepAlive;
  let streaming = false;

  try {
    if (req.aborted || res.destroyed) abortRequest();
    abortController.signal.throwIfAborted();

    let body;
    try {
      body = await readBody(req);
      validateBody(body);
    } catch (error) {
      if (requestPath === MESSAGES_PATH) {
        reportRequestFailure(requestId, { status: 400, type: "invalid_request_error" });
      }
      if (!res.destroyed) writeApiError(res, 400, "invalid_request_error", error.message);
      return;
    }

    // Flags also cover a disconnect whose event preceded listener registration.
    // Check before starting SSE or submitting any work to the session manager.
    if (req.aborted || res.destroyed) abortRequest();
    abortController.signal.throwIfAborted();

    if (requestPath === TOKEN_COUNT_PATH) {
      res.setHeader("x-ghcp-token-count-method", "estimated");
      writeJson(res, 200, { input_tokens: estimateTokens(body) });
      return;
    }

    streaming = Boolean(body.stream);
    let stream;
    let resolvedModel;
    const responseId = `msg_${requestId.replaceAll("-", "")}`;
    const inputTokens = estimateTokens(body);
    const ensureStream = (model = resolvedModel) => {
      if (!stream) {
        if (!model) throw new Error("The model must be resolved before streaming.");
        startSse(res);
        keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
        stream = new AnthropicSseStream(res, { id: responseId, inputTokens });
        stream.start(model);
      }
      return stream;
    };

    const fault = body.tools?.length
      ? testFaults.find((candidate) => candidate.remaining > 0)
      : null;
    if (fault) {
      fault.remaining -= 1;
      emitDiagnostic({
        event: "bridge.test_fault_injected",
        requestId,
        kind: fault.kind,
        remaining: fault.remaining,
      });
      throw fault.kind === "context_limit"
        ? manager.contextLimitErrorFor(req.headers)
        : testFaultError(fault.kind);
    }

    const result = await manager.execute(body, req.headers, {
      requestId,
      responseId,
      onReady: ({ model }) => { resolvedModel = model; },
      onEvent: (event) => {
        if (streaming && !event.agentId) ensureStream().handleSdkEvent(event);
      },
      signal: abortController.signal,
    });
    const response = {
      id: responseId,
      model: result.model,
      message: result.message,
      inputTokens: result.usage?.inputTokens ?? inputTokens,
      usage: result.usage,
    };

    if (streaming) ensureStream(result.model).finish(response);
    else writeJsonMessage(res, response);
    emitDiagnostic({
      event: "bridge.turn_completed",
      requestId,
      responseId,
      requestedModel: body.model ?? null,
      model: result.model,
      servedModels: result.servedModels ?? [],
      claudeAgent: req.headers["x-claude-code-agent-id"] ? "subagent" : "root",
      inputTokens: response.inputTokens,
      outputTokens: result.usage?.outputTokens ?? result.message.outputTokens ?? 0,
      usageReported: result.usage?.inputTokens != null,
      stopReason: anthropicStopReason(result.message, result.usage),
      // anthropicContent writes one tool_use block per surviving request.
      toolUses: result.message.toolRequests?.length ?? 0,
    });
  } catch (error) {
    const failure = error.name === "AbortError"
      ? { status: 499, type: "client_closed_request", retryAfterSeconds: null }
      : errorResponse(error);
    if (requestPath === MESSAGES_PATH) {
      reportRequestFailure(requestId, failure, {
        streaming,
        headersSent: Boolean(res.headersSent),
      });
    }
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
    if (streaming && res.headersSent) {
      writeSseError(res, error, failure.type);
      return;
    }
    writeApiError(
      res,
      failure.status,
      failure.type,
      error.message,
      failure.retryAfterSeconds == null
        ? undefined
        : { "retry-after": String(failure.retryAfterSeconds) },
    );
  } finally {
    clearInterval(keepAlive);
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

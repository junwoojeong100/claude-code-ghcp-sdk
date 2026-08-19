import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AnthropicSseStream,
  estimateTokens,
  startSse,
  writeJsonMessage,
  writeSseError,
} from "./anthropic.mjs";
import {
  gatewayModelEntries,
  ModelUnavailableError,
} from "./model-map.mjs";
import { SessionManager } from "./session-manager.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4142);
const apiKey = process.env.BRIDGE_API_KEY;
const preferredModel = process.env.GHCP_MODEL || "claude-sonnet-4.6";
const copilotHome = path.resolve(
  (process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot")).replace(/^~/, os.homedir()),
);
const logLevel = process.env.LOG_LEVEL || "error";
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);

if (!["127.0.0.1", "::1", "localhost"].includes(host) && process.env.ALLOW_NON_LOOPBACK !== "1") {
  throw new Error("The bridge only binds to loopback unless ALLOW_NON_LOOPBACK=1 is set.");
}
if (!apiKey && process.env.BRIDGE_ALLOW_UNAUTHENTICATED !== "1") {
  throw new Error("BRIDGE_API_KEY is required.");
}

const manager = new SessionManager({
  baseDirectory: copilotHome,
  preferredModel,
  logLevel,
});
await manager.start();

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authenticated(req) {
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

  if (req.method === "HEAD" && req.url?.startsWith("/api/hello")) {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      ok: true,
      preferredModel,
      modelCount: manager.listModels().length,
    });
    return;
  }
  if (!authenticated(req)) {
    json(res, 401, {
      type: "error",
      error: { type: "authentication_error", message: "Invalid bridge credential." },
    });
    return;
  }
  if (
    req.method === "GET" &&
    (req.url === "/v1/models" || req.url?.startsWith("/v1/models?"))
  ) {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    const includeAll = requestUrl.searchParams.get("all") === "true";
    json(res, 200, {
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
  if (req.method !== "POST") {
    json(res, 404, {
      type: "error",
      error: { type: "not_found_error", message: "Not found." },
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    json(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: error.message },
    });
    return;
  }

  if (req.url?.startsWith("/v1/messages/count_tokens")) {
    json(res, 200, { input_tokens: estimateTokens(body) });
    return;
  }
  if (!req.url?.startsWith("/v1/messages")) {
    json(res, 404, {
      type: "error",
      error: { type: "not_found_error", message: "Not found." },
    });
    return;
  }

  const streaming = Boolean(body.stream);
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
    });
    clearInterval(keepAlive);
    const response = {
      id: responseId,
      model: result.model,
      message: result.message,
      inputTokens,
    };

    if (streaming) stream.finish(response);
    else writeJsonMessage(res, response);
  } catch (error) {
    clearInterval(keepAlive);
    console.error(`[${requestId}] ${error.name}: ${error.message}`);
    if (streaming) {
      writeSseError(res, error);
      return;
    }
    json(res, error instanceof ModelUnavailableError ? 400 : 500, {
      type: "error",
      error: {
        type: error instanceof ModelUnavailableError ? "invalid_request_error" : "api_error",
        message: error.message,
      },
    });
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

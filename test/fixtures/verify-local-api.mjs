/** Deterministic loopback Messages fixture. Never delegates to any provider. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PRIMARY_MODELS, launchModelFor } from "../../src/model-map.mjs";
import { verificationRequest, verificationCompactSummarySha256 } from "../../src/verification-observer.mjs";

export const LOCAL_TOKEN = "verify-local-messages-only";
const text = (content) => typeof content === "string" ? content : (content ?? []).map(b => b.text ?? "").join("\n");
const allText = (body) => (body.messages ?? []).map(m => text(m.content)).join("\n");

export async function startLocalAPI({ directory, streamIntervalMs = 80, streamDelayMs = 350, codingFixture } = {}) {
  const records = [], sockets = new Set(), timers = new Set();
  if (directory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = (row) => {
    records.push(row);
    if (directory) fs.appendFileSync(path.join(directory, "requests.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
  const server = http.createServer(async (req, res) => {
    const authorization = req.headers.authorization;
    const key = req.headers["x-api-key"];
    if (authorization !== `Bearer ${LOCAL_TOKEN}` && key !== LOCAL_TOKEN) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Local fixture token required" } }));
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: PRIMARY_MODELS.map(id => ({ id: launchModelFor(id), type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" })),
        has_more: false, first_id: launchModelFor(PRIMARY_MODELS[0]), last_id: launchModelFor(PRIMARY_MODELS.at(-1)),
      }));
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
    }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (url.pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":256}');
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
    const id = `msg_local_${randomUUID().replaceAll("-", "")}`;
    const messages = body.messages ?? [];
    const history = allText(body);
    const userTexts = messages.filter(m => m.role === "user").flatMap(m => typeof m.content === "string" ? [m.content] :
      (m.content ?? []).filter(b => b.type === "text").map(b => b.text));
    const latest = userTexts.at(-1) ?? "";
    const compact = /create a detailed summary of the conversation/i.test(latest);
    const seed = history.match(/LOCAL_NONCE=([A-Za-z0-9_-]+)/)?.[1];
    const lastUser = messages.findLast(m => m.role === "user");
    const lastBlocks = Array.isArray(lastUser?.content) ? lastUser.content : [];
    const toolResults = lastBlocks.filter(b => b.type === "tool_result");
    const available = (body.tools ?? []).map(t => t.name);
    let content, stopReason = "end_turn";
    const toolName = available.find(n => n === "mcp__fixture__lookup");
    if (compact) content = [{ type: "text", text: `<analysis>Local fixture analysis.</analysis>\n\n<summary>Conversation summary. ${seed ? `LOCAL_NONCE=${seed}` : "No remembered nonce."} Continue answering requested local markers exactly.</summary>` }];
    else if (/LOCAL_CODE/.test(latest) && codingFixture) {
      const f = codingFixture;
      const calls = [
        ...[f.sampleFile, f.sourceFile, f.testFile].map(file => ["Read", { file_path: path.join(f.dir, file) }]),
        ["Bash", { command: f.testCommand.join(" ") }],
        ["Edit", { file_path: path.join(f.dir, f.sourceFile), old_string: f.source, new_string: f.fixedSource }],
        ["Bash", { command: f.testCommand.join(" ") }],
      ];
      const count = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "tool_result").length;
      if (count < calls.length) {
        const [name, input] = calls[count];
        content = [{ type: "tool_use", id: `toolu_local_${count}`, name, input }]; stopReason = "tool_use";
      } else content = [{ type: "text", text: f.sample }];
    }
    else if (/LOCAL_MCP/.test(latest) && toolName && !/LOCAL_MCP_RECALL/.test(latest)) {
      const resultBlocks = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "tool_result");
      if (toolResults.length && !toolResults.at(-1).is_error) content = [{ type: "text", text: text(toolResults.at(-1).content) }];
      else {
        content = [{ type: "tool_use", id: `toolu_local_${randomUUID().replaceAll("-", "")}`, name: toolName,
          input: { key: resultBlocks.length ? "selected" : "missing" } }];
        stopReason = "tool_use";
      }
    } else if (/LOCAL_MCP_RECALL/.test(latest)) {
      const found = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "tool_result" && !b.is_error).at(-1);
      content = [{ type: "text", text: found ? text(found.content) : "LOCAL_MCP_UNKNOWN" }];
    } else if (/LOCAL_RECALL/.test(latest)) content = [{ type: "text", text: seed ?? "LOCAL_UNKNOWN" }];
    else if (/LOCAL_NONCE=/.test(latest)) content = [{ type: "text", text: "LOCAL_REMEMBERED" }];
    else content = [{ type: "text", text: latest.match(/LOCAL_REPLY=([^\n]+)/)?.[1]?.trim() ?? "LOCAL_OK" }];
    const streaming = body.stream === true;
    const long = /LOCAL_(?:LONG|DELAYED|REASONING)_STREAM/.test(latest) && !compact;
    const reasoningOnly = long && /LOCAL_REASONING_STREAM/.test(latest);
    const delayed = long && /LOCAL_DELAYED_STREAM/.test(latest);
    record({ type: "request", id, body, claudeSessionId: req.headers["x-claude-code-session-id"] ?? null, compact, long, streaming, at: Date.now(),
      observation: verificationRequest(body, req.headers, { requestId: id, responseId: id }) });
    let finished = false;
    res.once("close", () => record({ type: "response", id, finished, aborted: !finished, at: Date.now(),
      compactSummarySha256: finished && !long ? verificationCompactSummarySha256(text(content)) : null }));
    const usage = { input_tokens: Math.max(10, Math.ceil(history.length / 4)), output_tokens: 10,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const message = { id, type: "message", role: "assistant", model: body.model, content,
      stop_reason: stopReason, stop_sequence: null, usage };
    if (!streaming) { finished = true; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
    const block = content[0];
    emit("content_block_start", { index: 0, content_block: reasoningOnly ? { type: "thinking", thinking: "" }
      : block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    const finish = () => {
      emit("content_block_stop", { index: 0 });
      emit("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
      emit("message_stop", {}); finished = true; res.end();
    };
    if (long) {
      let count = 0;
      const beginAt = Date.now() + (delayed ? streamDelayMs : 0);
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); timers.delete(timer); return; }
        if (Date.now() < beginAt) return;
        count++;
        emit("content_block_delta", { index: 0, delta: reasoningOnly
          ? { type: "thinking_delta", thinking: `LOCAL_THINKING_${count} ` }
          : { type: "text_delta", text: `LOCAL_STREAM_${count} ` } });
        record({ type: reasoningOnly ? "reasoning" : "progress", id, count, at: Date.now() });
        if (count >= 500) { clearInterval(timer); timers.delete(timer); finish(); }
      }, streamIntervalMs);
      timers.add(timer);
      res.once("close", () => { clearInterval(timer); timers.delete(timer); });
    } else {
      emit("content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text }
        : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      finish();
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl, token: LOCAL_TOKEN, records,
    async close() {
      for (const timer of timers) clearInterval(timer);
      const closedSockets = [...sockets].map(socket => new Promise(resolve => {
        socket.once("close", resolve); socket.destroy();
      }));
      await Promise.all([new Promise(resolve => server.close(resolve)), ...closedSockets]);
      return { ok: !server.listening && sockets.size === 0, port: new URL(baseUrl).port };
    },
  };
}

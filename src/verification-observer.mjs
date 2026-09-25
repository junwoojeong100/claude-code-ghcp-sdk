import { createHash } from "node:crypto";

const MODEL_STATE_TIMEOUT_MS = 5_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Only the verifier enables these observations. Never copy whole requests,
// headers, SDK payloads or error messages into the diagnostic stream.
export function verificationEffort(body) {
  return typeof body.output_config?.effort === "string" ? body.output_config.effort : null;
}

// Native CLI 2.1.282 normalizes the summary response before storing it inside
// the continuation wrapper. Retain only its digest, never the response text.
export function verificationCompactSummarySha256(content) {
  if (typeof content !== "string") return null;
  const summary = content.replace(/<analysis>[\s\S]*?<\/analysis>/, "")
    .replace(/<summary>([\s\S]*?)<\/summary>/, (_match, text) => `Summary:\n${text.trim()}`)
    .replace(/\n\n+/g, "\n\n").trim();
  return summary ? sha256(summary) : null;
}

function textHashes(content, nested = false) {
  if (typeof content === "string") return [sha256(content)];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text" && typeof block.text === "string") return [sha256(block.text)];
    if (nested && block?.type === "tool_result") return textHashes(block.content, true);
    return [];
  });
}

export function verificationRequest(body, headers, { requestId, responseId }) {
  const messages = body.messages ?? [];
  const blocks = messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  const sessionHeader = headers["x-claude-code-session-id"];
  const lastUser = messages.findLast(message => message.role === "user")?.content;
  const lastText = typeof lastUser === "string" ? lastUser : Array.isArray(lastUser)
    ? lastUser.filter(block => block?.type === "text").map(block => block.text).at(-1) ?? "" : "";
  return {
    event: "bridge.verify_request",
    requestId,
    responseId,
    requestedModel: body.model ?? null,
    claudeSessionId: (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ?? null,
    claudeAgent: headers["x-claude-code-agent-id"] ? "subagent" : "root",
    streaming: Boolean(body.stream),
    compactRequested: /Your task is to create a detailed summary of the conversation so far\b/.test(lastText),
    effort: verificationEffort(body),
    messageCount: messages.length,
    messagesSha256: sha256(JSON.stringify(messages)),
    userTextHashes: messages.filter((message) => message.role === "user")
      .flatMap((message) => textHashes(message.content)),
    messageDigests: messages.map((message) => ({
      role: ["user", "assistant", "system"].includes(message.role) ? message.role : null,
      sha256: sha256(JSON.stringify(message)),
      textHashes: textHashes(message.content, true),
    })),
    toolResultIds: blocks.filter((block) => block?.type === "tool_result" && typeof block.tool_use_id === "string")
      .map((block) => block.tool_use_id),
    toolUseIds: blocks.filter((block) => block?.type === "tool_use" && typeof block.id === "string")
      .map((block) => block.id),
  };
}

export function emitVerificationDiagnostic(onDiagnostic, event) {
  // A diagnostic sink failure must not change an HTTP response or model turn.
  try { Promise.resolve(onDiagnostic(event)).catch(() => {}); } catch {}
}

export function observeVerificationResponse(res, { requestId, responseId, streaming }, onDiagnostic) {
  let emitted = false;
  const report = (finished) => {
    if (emitted) return;
    emitted = true;
    res.removeListener("finish", onFinish);
    res.removeListener("close", onClose);
    emitVerificationDiagnostic(onDiagnostic, {
      event: "bridge.verify_response",
      requestId,
      responseId,
      // No headers means no HTTP status was sent, even if statusCode is 200.
      status: res.headersSent ? res.statusCode : null,
      streaming: streaming(),
      finished,
      aborted: !finished,
    });
  };
  const onFinish = () => report(true);
  const onClose = () => report(res.writableFinished === true);
  res.once("finish", onFinish);
  res.once("close", onClose);
}

export async function readVerificationModelState(session, signal) {
  let timer;
  let onAbort;
  const timeout = Symbol("timeout");
  const aborted = Symbol("aborted");
  try {
    if (signal?.aborted) return { ok: false, current: null, error: "aborted" };
    const modelRpc = session.rpc?.model;
    if (typeof modelRpc?.getCurrent !== "function") {
      return { ok: false, current: null, error: "unavailable" };
    }
    const current = await Promise.race([
      Promise.resolve().then(() => modelRpc.getCurrent()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeout), MODEL_STATE_TIMEOUT_MS);
        onAbort = () => reject(aborted);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
    // CurrentModel in the installed SDK's generated/rpc.d.ts has these three
    // optional string fields. Missing fields stay missing, never inferred.
    const fields = ["modelId", "reasoningEffort", "contextTier"];
    if (!current || typeof current !== "object" || Array.isArray(current) ||
        fields.some((field) => current[field] !== undefined && typeof current[field] !== "string")) {
      return { ok: false, current: null, error: "invalid_response" };
    }
    return {
      ok: true,
      current: Object.fromEntries(fields.filter((field) => current[field] !== undefined)
        .map((field) => [field, current[field]])),
    };
  } catch (error) {
    return { ok: false, current: null, error: error === timeout ? "timeout" : error === aborted ? "aborted" : "rpc_error" };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function extractSystem(system, messages = []) {
  const context = [];
  for (const message of messages) {
    if (message?.role !== "system") continue;
    // Budget telemetry changes every request; agent/style/permission instructions do not.
    const text = extractText(message.content)
      .replace(/<system-reminder>\s*<total_tokens>\d+ tokens left<\/total_tokens>\s*<\/system-reminder>/g, "")
      .replace(/<total_tokens>\d+ tokens left<\/total_tokens>/g, "")
      .trim();
    if (!text) continue;
    const previous = context.indexOf(text);
    if (previous >= 0) context.splice(previous, 1);
    context.push(text);
  }
  return [extractText(system) || "You are a helpful coding assistant.", ...context].join("\n\n");
}

export function extractReasoningEffort(body) {
  const effort = body?.output_config?.effort;
  if (typeof effort !== "string" || !effort.trim()) return null;

  const normalized = effort.trim().toLowerCase();
  return normalized === "ultracode" ? "xhigh" : normalized;
}

export function lastMessage(messages = []) {
  return messages.findLast((message) => message?.role !== "system");
}

function lastMessageIndex(messages = []) {
  return messages.findLastIndex((message) => message?.role !== "system");
}

function attachmentFromBlock(block, index) {
  const source = block?.source;
  if (!source || source.type !== "base64" || typeof source.data !== "string") {
    return null;
  }

  return {
    type: "blob",
    data: source.data,
    mimeType: source.media_type || "application/octet-stream",
    displayName: `${block.type || "attachment"}-${index + 1}`,
  };
}

function toolResultValue(block) {
  const textParts = [];
  const binaryResultsForLlm = [];
  const content =
    typeof block.content === "string"
      ? [{ type: "text", text: block.content }]
      : block.content;

  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
      continue;
    }
    if (item?.type === "tool_reference" && typeof item.tool_name === "string") {
      textParts.push(`[tool_reference ${JSON.stringify(item.tool_name)}]`);
      continue;
    }

    const attachment = attachmentFromBlock(item, binaryResultsForLlm.length);
    if (attachment) {
      binaryResultsForLlm.push({
        data: attachment.data,
        mimeType: attachment.mimeType,
        type: item.type === "image" ? "image" : "resource",
        description: attachment.displayName,
      });
    }
  }

  return {
    textResultForLlm: textParts.join("\n"),
    ...(binaryResultsForLlm.length ? { binaryResultsForLlm } : {}),
    resultType: block.is_error ? "failure" : "success",
    ...(block.is_error ? { error: textParts.join("\n") || "Claude Code tool failed." } : {}),
  };
}

function replayToolResultText(block) {
  const value = toolResultValue(block);
  // Replayed history is plain text, so a converted image or document becomes a
  // placeholder naming its media type and size instead of disappearing.
  const attachments = (value.binaryResultsForLlm || []).map(
    (item) =>
      `[attachment ${item.description} ${item.mimeType} ${Buffer.byteLength(item.data, "base64")} bytes]`,
  );
  return [value.textResultForLlm, ...attachments].filter(Boolean).join("\n");
}

export function extractTurnInput(body) {
  const messages = body.messages || [];
  const messageIndex = lastMessageIndex(messages);
  const message = messages[messageIndex];
  if (message?.role !== "user") {
    return { kind: "continuation", attachments: [] };
  }

  const blocks = Array.isArray(message.content) ? message.content : [];
  const toolResults = blocks
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      toolUseId: block.tool_use_id,
      value: toolResultValue(block),
    }));

  if (toolResults.length) {
    return {
      kind: "tool-results",
      toolResults,
      prompt: extractText(message.content),
      messageIndex,
    };
  }

  const attachments = blocks
    .map((block, index) => attachmentFromBlock(block, index))
    .filter(Boolean);

  return {
    kind: "prompt",
    prompt: extractText(message.content),
    attachments,
    messageIndex,
  };
}

export function serializeConversation(messages = []) {
  return messages
    .map((message) => {
      const role = String(message?.role || "unknown").toUpperCase();
      if (typeof message?.content === "string") return `${role}: ${message.content}`;
      if (!Array.isArray(message?.content)) return `${role}:`;

      const rendered = message.content
        .map((block) => {
          if (block?.type === "text") return block.text;
          if (block?.type === "tool_use") {
            const id = typeof block.id === "string" ? ` id=${JSON.stringify(block.id)}` : "";
            return `[tool_use ${block.name}${id} ${JSON.stringify(block.input || {})}]`;
          }
          if (block?.type === "tool_result") {
            const error = block.is_error ? " is_error=true" : "";
            return `[tool_result ${block.tool_use_id}${error} ${replayToolResultText(block)}]`;
          }
          return `[${block?.type || "content"}]`;
        })
        .join("\n");
      return `${role}: ${rendered}`;
    })
    .join("\n\n");
}

export function serializeConversationTail(messages = [], maxBytes = 268_435_456) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer.");
  }

  const rendered = messages.map((message) => serializeConversation([message]));
  const selected = [];
  let selectedBytes = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const separatorBytes = selected.length ? 2 : 0;
    const messageBytes = Buffer.byteLength(rendered[index]);
    if (selectedBytes + separatorBytes + messageBytes > maxBytes) break;
    selected.unshift(rendered[index]);
    selectedBytes += separatorBytes + messageBytes;
  }

  const truncated = selected.length < rendered.length;
  return {
    text: [
      ...(truncated ? ["[... prior conversation truncated ...]"] : []),
      ...selected,
    ].join("\n\n"),
    truncated,
  };
}

function normalizeToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return {};
}

export function anthropicContent(message) {
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });

  for (const tool of message.toolRequests || []) {
    content.push({
      type: "tool_use",
      id: tool.toolCallId,
      name: tool.name,
      input: normalizeToolArguments(tool.arguments),
    });
  }

  return content;
}

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value || {}).length / 4));
}

function anthropicStopReason(message, usage) {
  if (message.toolRequests?.length) return "tool_use";
  if (usage?.contentFilterTriggered || usage?.finishReason === "content_filter") {
    return "refusal";
  }
  if (usage?.finishReason === "length") return "max_tokens";
  if (usage?.finishReason === "stop_sequence") return "stop_sequence";
  return "end_turn";
}

function anthropicUsage(inputTokens, message, usage) {
  return {
    input_tokens: usage?.inputTokens || inputTokens,
    output_tokens: usage?.outputTokens || message.outputTokens || 0,
    ...(usage?.cacheReadTokens
      ? { cache_read_input_tokens: usage.cacheReadTokens }
      : {}),
    ...(usage?.cacheWriteTokens
      ? { cache_creation_input_tokens: usage.cacheWriteTokens }
      : {}),
  };
}

export function writeJsonMessage(
  res,
  { id, model, message, inputTokens, usage },
) {
  const body = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: anthropicContent(message),
    stop_reason: anthropicStopReason(message, usage),
    stop_sequence: null,
    usage: anthropicUsage(inputTokens, message, usage),
  };
  const rendered = JSON.stringify(body);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(rendered),
  });
  res.end(rendered);
}

export function startSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

function event(res, name, data) {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export class AnthropicSseStream {
  constructor(res, { id, inputTokens }) {
    this.res = res;
    this.id = id;
    this.inputTokens = inputTokens;
    this.started = false;
    this.model = null;
    this.nextIndex = 0;
    this.textBlock = null;
    this.toolBlocks = new Map();
  }

  start(model) {
    if (this.started) return;
    this.started = true;
    this.model = model;
    event(this.res, "message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  handleSdkEvent(sdkEvent) {
    if (sdkEvent.agentId) return;

    if (sdkEvent.type === "assistant.message_delta") {
      this.#writeTextDelta(sdkEvent.data.deltaContent || "");
      return;
    }

    // assistant.tool_call_delta is deliberately not written through. Copilot
    // also emits deltas for calls it never registers, and only the bridge's
    // finishTurn knows which ones survive. A content_block_start cannot be
    // retracted once it is on the wire, so opening a tool block here would
    // frame a tool_use that later has no input and no "tool_use" stop reason.
    // Nothing is lost by waiting: the input JSON was never streamed from the
    // deltas either, finish() writes each surviving call in full.
  }

  finish({ model, message, usage }) {
    this.start(model);

    const streamedContent = this.textBlock?.content || "";
    const remainingContent = message.content?.startsWith(streamedContent)
      ? message.content.slice(streamedContent.length)
      : "";
    this.#writeTextDelta(remainingContent);

    for (const tool of message.toolRequests || []) {
      const block = this.#ensureToolBlock(tool.toolCallId, tool.name);
      this.#writeToolInputDelta(
        block,
        JSON.stringify(normalizeToolArguments(tool.arguments)),
      );
    }

    const blocks = [
      ...(this.textBlock ? [this.textBlock] : []),
      ...this.toolBlocks.values(),
    ].sort((left, right) => left.index - right.index);
    for (const block of blocks) {
      event(this.res, "content_block_stop", {
        type: "content_block_stop",
        index: block.index,
      });
    }

    event(this.res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: anthropicStopReason(message, usage),
        stop_sequence: null,
      },
      usage: anthropicUsage(this.inputTokens, message, usage),
    });
    event(this.res, "message_stop", { type: "message_stop" });
    this.res.end();
  }

  #writeTextDelta(text) {
    if (!text) return;
    if (!this.textBlock) {
      this.textBlock = { index: this.nextIndex++, content: "" };
      event(this.res, "content_block_start", {
        type: "content_block_start",
        index: this.textBlock.index,
        content_block: { type: "text", text: "" },
      });
    }
    this.textBlock.content += text;
    event(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: this.textBlock.index,
      delta: { type: "text_delta", text },
    });
  }

  #ensureToolBlock(toolCallId, toolName) {
    const existing = this.toolBlocks.get(toolCallId);
    if (existing) return existing;

    const block = {
      index: this.nextIndex++,
      name: toolName,
    };
    this.toolBlocks.set(toolCallId, block);
    event(this.res, "content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: {
        type: "tool_use",
        id: toolCallId,
        name: toolName,
        input: {},
      },
    });

    return block;
  }

  #writeToolInputDelta(block, inputDelta) {
    if (!inputDelta) return;
    event(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "input_json_delta", partial_json: inputDelta },
    });
  }
}

export function writeSseError(res, error) {
  event(res, "error", {
    type: "error",
    error: {
      type: "api_error",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  res.end();
}

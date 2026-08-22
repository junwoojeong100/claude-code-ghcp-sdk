export function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function extractSystem(system) {
  return extractText(system) || "You are a helpful coding assistant.";
}

export function extractReasoningEffort(body) {
  const effort = body?.output_config?.effort;
  if (typeof effort !== "string" || !effort.trim()) return null;

  const normalized = effort.trim().toLowerCase();
  return normalized === "ultracode" ? "xhigh" : normalized;
}

export function lastMessage(messages = []) {
  return messages.at(-1);
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

export function extractTurnInput(body) {
  const message = lastMessage(body.messages);
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
    return { kind: "tool-results", toolResults };
  }

  const attachments = blocks
    .map((block, index) => attachmentFromBlock(block, index))
    .filter(Boolean);

  return {
    kind: "prompt",
    prompt: extractText(message.content),
    attachments,
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
            return `[tool_use ${block.name} ${JSON.stringify(block.input || {})}]`;
          }
          if (block?.type === "tool_result") {
            return `[tool_result ${block.tool_use_id} ${extractText(block.content)}]`;
          }
          return `[${block?.type || "content"}]`;
        })
        .join("\n");
      return `${role}: ${rendered}`;
    })
    .join("\n\n");
}

export function anthropicContent(message) {
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });

  for (const tool of message.toolRequests || []) {
    content.push({
      type: "tool_use",
      id: tool.toolCallId,
      name: tool.name,
      input: tool.arguments || {},
    });
  }

  return content;
}

export function estimateTokens(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value || {}).length / 4));
}

export function writeJsonMessage(res, { id, model, message, inputTokens }) {
  const hasTools = Boolean(message.toolRequests?.length);
  const body = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: anthropicContent(message),
    stop_reason: hasTools ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: message.outputTokens || 0,
    },
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
    this.pendingToolDeltas = new Map();
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

    if (sdkEvent.type === "assistant.tool_call_delta") {
      const data = sdkEvent.data;
      let block = this.toolBlocks.get(data.toolCallId);
      if (!block && !data.toolName) {
        const pending = this.pendingToolDeltas.get(data.toolCallId) || [];
        if (data.inputDelta) pending.push(data.inputDelta);
        this.pendingToolDeltas.set(data.toolCallId, pending);
        return;
      }
      block ||= this.#ensureToolBlock(data.toolCallId, data.toolName);
      this.#writeToolInputDelta(block, data.inputDelta);
    }
  }

  finish({ model, message }) {
    this.start(model);

    const streamedContent = this.textBlock?.content || "";
    const remainingContent = message.content?.startsWith(streamedContent)
      ? message.content.slice(streamedContent.length)
      : "";
    this.#writeTextDelta(remainingContent);

    for (const tool of message.toolRequests || []) {
      const block = this.#ensureToolBlock(tool.toolCallId, tool.name);
      if (!block.hasInputDelta) {
        this.#writeToolInputDelta(block, JSON.stringify(tool.arguments || {}));
      }
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
        stop_reason: message.toolRequests?.length ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: message.outputTokens || 0 },
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
      hasInputDelta: false,
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

    const pending = this.pendingToolDeltas.get(toolCallId) || [];
    this.pendingToolDeltas.delete(toolCallId);
    for (const inputDelta of pending) {
      this.#writeToolInputDelta(block, inputDelta);
    }
    return block;
  }

  #writeToolInputDelta(block, inputDelta) {
    if (!inputDelta) return;
    block.hasInputDelta = true;
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

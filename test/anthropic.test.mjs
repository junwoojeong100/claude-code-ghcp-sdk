import test from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicSseStream,
  anthropicContent,
  extractReasoningEffort,
  extractSystem,
  extractTurnInput,
  serializeConversation,
  serializeConversationTail,
  startSse,
  writeJsonMessage,
} from "../src/anthropic.mjs";

function fakeResponse() {
  return {
    chunks: [],
    ended: false,
    writeHead() {},
    write(value) {
      this.chunks.push(value);
    },
    end(value) {
      if (value) this.chunks.push(value);
      this.ended = true;
    },
  };
}

test("extracts Claude Code system text blocks", () => {
  assert.equal(
    extractSystem([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );
});

test("extracts Claude Code effort and normalizes ultracode to xhigh", () => {
  assert.equal(
    extractReasoningEffort({ output_config: { effort: "xhigh" } }),
    "xhigh",
  );
  assert.equal(
    extractReasoningEffort({ output_config: { effort: "ultracode" } }),
    "xhigh",
  );
  assert.equal(extractReasoningEffort({ output_config: {} }), null);
});

test("extracts prompt and base64 attachments", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
          },
        ],
      },
    ],
  });

  assert.equal(input.kind, "prompt");
  assert.equal(input.prompt, "inspect this");
  assert.deepEqual(input.attachments[0], {
    type: "blob",
    data: "AA==",
    mimeType: "image/png",
    displayName: "image-2",
  });
});

test("converts Claude tool results for the pending Copilot tool call", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "done",
          },
        ],
      },
    ],
  });

  assert.equal(input.kind, "tool-results");
  assert.equal(input.toolResults[0].toolUseId, "tool-1");
  assert.equal(input.toolResults[0].value.textResultForLlm, "done");
});

test("finds a tool result before trailing Claude Code system messages", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "done",
          },
        ],
      },
      {
        role: "system",
        content: "Tool execution completed.",
      },
    ],
  });

  assert.equal(input.kind, "tool-results");
  assert.equal(input.messageIndex, 1);
  assert.equal(input.toolResults[0].toolUseId, "tool-1");
});

test("preserves sibling text from an updated tool result", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "final result",
          },
          {
            type: "text",
            text: "The background agent completed.",
          },
        ],
      },
    ],
  });

  assert.equal(input.kind, "tool-results");
  assert.equal(input.prompt, "The background agent completed.");
  assert.equal(
    input.toolResults[0].value.textResultForLlm,
    "final result",
  );
});

test("finds a prompt before trailing Claude Code system messages", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "inspect this" }],
      },
      {
        role: "system",
        content: "Prompt metadata.",
      },
    ],
  });

  assert.equal(input.kind, "prompt");
  assert.equal(input.prompt, "inspect this");
  assert.equal(input.messageIndex, 0);
});

test("does not replay a historical tool result when history ends with assistant", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "parent-agent",
            content: "Agent started.",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Waiting for the agent." }],
      },
    ],
  });

  assert.equal(input.kind, "continuation");
});

test("does not replay a historical tool result before assistant and system messages", () => {
  const input = extractTurnInput({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "parent-agent",
            content: "Agent started.",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Waiting for the agent." }],
      },
      {
        role: "system",
        content: "Agent status updated.",
      },
    ],
  });

  assert.equal(input.kind, "continuation");
});

test("renders Copilot tool requests as Anthropic tool_use blocks", () => {
  assert.deepEqual(
    anthropicContent({
      content: "checking",
      toolRequests: [
        {
          toolCallId: "tool-1",
          name: "Read",
          arguments: { file_path: "/tmp/a" },
        },
      ],
    }),
    [
      { type: "text", text: "checking" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "/tmp/a" },
      },
    ],
  );
});

test("uses actual SDK usage and finish reason in non-streaming responses", () => {
  const response = fakeResponse();
  writeJsonMessage(response, {
    id: "msg-usage",
    inputTokens: 10,
    message: { content: "partial", outputTokens: 1, toolRequests: [] },
    model: "gpt-5.6-sol",
    usage: {
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      finishReason: "length",
      inputTokens: 100,
      outputTokens: 20,
    },
  });

  const body = JSON.parse(response.chunks.at(-1));
  assert.equal(body.stop_reason, "max_tokens");
  assert.deepEqual(body.usage, {
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 3,
    input_tokens: 100,
    output_tokens: 20,
  });
});

test("serializes prior conversation for cold recovery", () => {
  const rendered = serializeConversation([
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.match(rendered, /USER: hello/);
  assert.match(rendered, /ASSISTANT: hi/);
});

test("bounds cold-recovery history at whole-message boundaries", () => {
  const replay = serializeConversationTail(
    [
      { role: "user", content: "first message" },
      { role: "assistant", content: "second message" },
      { role: "user", content: "final" },
    ],
    24,
  );

  assert.equal(replay.truncated, true);
  assert.match(replay.text, /prior conversation truncated/);
  assert.match(replay.text, /USER: final/);
  assert.doesNotMatch(replay.text, /first message/);
});

test("streams text deltas without duplicating final content", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-1",
    inputTokens: 10,
  });
  stream.start("claude-haiku-4.5");
  stream.handleSdkEvent({
    type: "assistant.message_delta",
    data: { deltaContent: "hello" },
  });
  stream.finish({
    model: "claude-haiku-4.5",
    message: { content: "hello", toolRequests: [], outputTokens: 1 },
  });

  const output = response.chunks.join("");
  assert.equal((output.match(/hello/g) || []).length, 1);
  assert.equal(response.ended, true);
});

test("reports actual SDK usage in the final streaming delta", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-usage",
    inputTokens: 10,
  });
  stream.finish({
    model: "gpt-5.6-sol",
    message: { content: "done", toolRequests: [], outputTokens: 1 },
    usage: {
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      inputTokens: 100,
      outputTokens: 20,
    },
  });

  const events = response.chunks
    .join("")
    .split(/\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const delta = events.find((event) => event.type === "message_delta");
  assert.deepEqual(delta.usage, {
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 3,
    input_tokens: 100,
    output_tokens: 20,
  });
});

test("replaces incomplete tool deltas with final valid JSON", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-2",
    inputTokens: 10,
  });
  stream.start("claude-haiku-4.5");
  stream.handleSdkEvent({
    type: "assistant.tool_call_delta",
    data: { toolCallId: "tool-1", inputDelta: "{\"file_path\":" },
  });
  stream.finish({
    model: "claude-haiku-4.5",
    message: {
      content: "",
      toolRequests: [
        {
          toolCallId: "tool-1",
          name: "Read",
          arguments: { file_path: "/tmp/a" },
        },
      ],
      outputTokens: 1,
    },
  });

  const output = response.chunks.join("");
  assert.match(output, /"name":"Read"/);
  assert.doesNotMatch(output, /"name":"tool"/);
  const partialJson = output
    .split(/\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data.delta?.type === "input_json_delta")
    .map((data) => data.delta.partial_json)
    .join("");
  assert.deepEqual(JSON.parse(partialJson), { file_path: "/tmp/a" });
});

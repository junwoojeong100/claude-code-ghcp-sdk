import test from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicSseStream,
  anthropicContent,
  extractReasoningEffort,
  extractSystem,
  extractTurnInput,
  serializeConversation,
  startSse,
} from "../src/anthropic.mjs";

function fakeResponse() {
  return {
    chunks: [],
    ended: false,
    writeHead() {},
    write(value) {
      this.chunks.push(value);
    },
    end() {
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

test("serializes prior conversation for cold recovery", () => {
  const rendered = serializeConversation([
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.match(rendered, /USER: hello/);
  assert.match(rendered, /ASSISTANT: hi/);
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

test("buffers tool JSON until the tool name is known", () => {
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
});

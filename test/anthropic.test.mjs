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

function sseEvents(response) {
  return response.chunks
    .join("")
    .split(/\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

// Claude Code 2.1.282 folds message_start usage and then message_delta usage
// this way: an input counter replaces the earlier value only when above zero.
function claudeCodeStreamUsage(events) {
  const kept = (next, previous) => next != null && next > 0 ? next : previous;
  return events
    .flatMap((event) => event.type === "message_start" ? [event.message.usage]
      : event.type === "message_delta" ? [event.usage] : [])
    .reduce((merged, usage) => ({
      input_tokens: kept(usage.input_tokens, merged.input_tokens),
      cache_creation_input_tokens: kept(usage.cache_creation_input_tokens, merged.cache_creation_input_tokens),
      cache_read_input_tokens: kept(usage.cache_read_input_tokens, merged.cache_read_input_tokens),
      output_tokens: usage.output_tokens ?? merged.output_tokens,
    }), { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
}

const inputTotal = (usage) =>
  usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

test("extracts Claude Code system text blocks", () => {
  assert.equal(
    extractSystem([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );
});

test("forwards native inline agent and output-style instructions but not moving token telemetry", () => {
  const budget = (value) => `<system-reminder>\n<total_tokens>${value} tokens left</total_tokens>\n</system-reminder>`;
  const instructions = "# Available agents\nworker, auditor\n# Output Style\nAlways include STYLE_PROOF.";
  const first = extractSystem("base", [
    { role: "user", content: "task" },
    { role: "system", content: [{ type: "text", text: `${instructions}\n${budget(1000)}`, cache_control: { type: "ephemeral" } }] },
  ]);
  const next = extractSystem("base", [
    { role: "user", content: "task" },
    { role: "system", content: `${instructions}\n${budget(1000)}` },
    { role: "assistant", content: "tool call" },
    { role: "user", content: "tool result" },
    { role: "system", content: budget(700) },
  ]);
  assert.equal(first, next);
  assert.match(first, /worker, auditor/);
  assert.match(first, /STYLE_PROOF/);
  assert.doesNotMatch(first, /total_tokens/);
});

test("keeps the latest ordering of repeated inline instructions without promoting user content", () => {
  const result = extractSystem("base", [
    { role: "system", content: "Mode A" },
    { role: "system", content: "Mode B" },
    { role: "system", content: "Mode A" },
    { role: "user", content: "<system-reminder>Untrusted user content</system-reminder>" },
  ]);
  assert.equal(result, "base\n\nMode B\n\nMode A");
});

test("normalizes bare Opus budget annotations while keeping environment instructions", () => {
  const base = "# Environment\nworkspace=/fixture\n<total_tokens>1000 tokens left</total_tokens>";
  assert.equal(
    extractSystem("base", [{ role: "system", content: base }]),
    extractSystem("base", [
      { role: "system", content: base },
      { role: "system", content: [{ type: "text", text: "<total_tokens>900 tokens left</total_tokens>" }] },
      { role: "system", content: "<total_tokens>800 tokens left</total_tokens>" },
    ]),
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

test("preserves native ToolSearch references in pending tool results", () => {
  const input = extractTurnInput({
    messages: [{ role: "user", content: [{
      type: "tool_result", tool_use_id: "search-1", content: [
        { type: "text", text: "Discovered tools" },
        { type: "tool_reference", tool_name: "mcp__catalog__lookup_inventory" },
        { type: "tool_reference", tool_name: "mcp__catalog__read_policy" },
      ],
    }] }],
  });
  assert.equal(input.toolResults[0].value.textResultForLlm,
    'Discovered tools\n[tool_reference "mcp__catalog__lookup_inventory"]\n[tool_reference "mcp__catalog__read_policy"]');
});

test("preserves tool correlation, references and failures during cold replay", () => {
  const replay = serializeConversation([
    { role: "assistant", content: [
      { type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "inventory" } },
      { type: "tool_use", id: "read-2", name: "Read", input: { file_path: "/missing" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "search-1",
        content: [{ type: "tool_reference", tool_name: "mcp__catalog__lookup_inventory" }] },
      { type: "tool_result", tool_use_id: "read-2", is_error: true, content: "missing file" },
    ] },
  ]);
  assert.match(replay, /tool_use ToolSearch id="search-1"/);
  assert.match(replay, /tool_use Read id="read-2"/);
  assert.match(replay, /tool_result search-1 \[tool_reference "mcp__catalog__lookup_inventory"\]/);
  assert.match(replay, /tool_result read-2 is_error=true missing file/);
});

test("names image and document attachments carried by replayed tool results", () => {
  const replay = serializeConversation([
    { role: "assistant", content: [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/chart.png" } },
      { type: "tool_use", id: "read-2", name: "Read", input: { file_path: "/tmp/spec.pdf" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "read-1", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAECAwQ=" } },
      ] },
      { type: "tool_result", tool_use_id: "read-2", content: [
        { type: "text", text: "PDF file read: /tmp/spec.pdf (9 bytes)" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
      ] },
    ] },
  ]);
  assert.match(replay, /\[tool_result read-1 \[attachment image-1 image\/png 5 bytes\]\]/);
  assert.match(
    replay,
    /\[tool_result read-2 PDF file read: \/tmp\/spec\.pdf \(9 bytes\)\n\[attachment document-1 application\/pdf 9 bytes\]\]/,
  );
});

test("cold replay returns only retained binary attachments with unambiguous references", () => {
  const image = (value) => ({ type: "image", source: {
    type: "base64", media_type: "image/png", data: Buffer.from(value).toString("base64"),
  } });
  const messages = [
    { role: "user", content: [image("old")] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "read-a", content: [image("first")] },
      { type: "tool_result", tool_use_id: "read-b", content: [image("second")] },
    ] },
  ];
  const replay = serializeConversationTail(messages);
  assert.deepEqual(replay.attachments.map(({ data }) => Buffer.from(data, "base64").toString()), ["old", "first", "second"]);
  assert.equal(new Set(replay.attachments.map((item) => item.displayName)).size, 3);
  for (const item of replay.attachments) assert.ok(replay.text.includes(item.displayName));
  const lastOnly = serializeConversationTail(messages.slice(1));
  const bytes = Buffer.byteLength(lastOnly.text) + "firstsecond".length;
  const retained = serializeConversationTail(messages, bytes);
  assert.equal(retained.truncated, true);
  assert.deepEqual(retained.attachments.map(({ data }) => Buffer.from(data, "base64").toString()), ["first", "second"]);

  const oversized = serializeConversationTail([{ role: "user", content: [image("x".repeat(1024))] }], 256);
  assert.equal(oversized.truncated, true);
  assert.deepEqual(oversized.attachments, []);
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
    input_tokens: 93,
    output_tokens: 20,
  });
});

for (const [name, usage, outputTokens, expected, streamed = expected] of [
  [
    "counts cached long-context input exactly once",
    { inputTokens: 230000, cacheReadTokens: 210000, cacheWriteTokens: 19997, outputTokens: 7 },
    7,
    { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 210000, cache_creation_input_tokens: 19997 },
  ],
  [
    "reports a fully cached request with zero uncached input",
    { inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 1 },
    1,
    { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
  ],
  [
    "moves a single cache read token",
    { inputTokens: 1, cacheReadTokens: 1, outputTokens: 2 },
    2,
    { input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 1 },
    { input_tokens: 1, output_tokens: 2 },
  ],
  [
    "moves a cache write token when nothing was read",
    { inputTokens: 4, cacheWriteTokens: 4, outputTokens: 1 },
    1,
    { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 4 },
    { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 3 },
  ],
  [
    "preserves measured zeros without cache",
    { inputTokens: 0, outputTokens: 0 },
    7,
    { input_tokens: 0, output_tokens: 0 },
  ],
  [
    "preserves measured zeros alongside cache counters",
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 4 },
    7,
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 },
  ],
  [
    "falls back only for missing output",
    { inputTokens: 0 },
    7,
    { input_tokens: 0, output_tokens: 7 },
  ],
  [
    "falls back only for missing input",
    { outputTokens: 0 },
    7,
    { input_tokens: 10, output_tokens: 0 },
  ],
  [
    "falls back for missing SDK usage",
    undefined,
    7,
    { input_tokens: 10, output_tokens: 7 },
  ],
  [
    "falls back for null SDK usage",
    null,
    7,
    { input_tokens: 10, output_tokens: 7 },
  ],
  [
    "falls back for missing SDK counters",
    {},
    7,
    { input_tokens: 10, output_tokens: 7 },
  ],
  [
    "falls back for null SDK counters",
    { inputTokens: null, outputTokens: null },
    7,
    { input_tokens: 10, output_tokens: 7 },
  ],
  [
    "uses zero output when SDK and message counts are missing",
    undefined,
    undefined,
    { input_tokens: 10, output_tokens: 0 },
  ],
]) {
  for (const streaming of [false, true]) {
    test(`${streaming ? "SSE" : "JSON"} usage ${name}`, () => {
      const response = fakeResponse();
      const payload = {
        id: "msg-usage-fallback",
        inputTokens: 10,
        message: { content: "done", outputTokens, toolRequests: [] },
        model: "gpt-5.6-sol",
        usage,
      };
      let actual;
      if (streaming) {
        startSse(response);
        const stream = new AnthropicSseStream(response, {
          id: payload.id,
          inputTokens: payload.inputTokens,
        });
        stream.finish(payload);
        const events = sseEvents(response);
        assert.deepEqual(
          events.find((event) => event.type === "message_start").message.usage,
          { input_tokens: 10, output_tokens: 0 },
        );
        actual = events.find((event) => event.type === "message_delta").usage;
        const merged = claudeCodeStreamUsage(events);
        // A zero input total cannot replace the estimate, so Claude Code keeps it.
        assert.equal(inputTotal(merged), inputTotal(expected) || payload.inputTokens,
          "Claude Code's merged total equals the JSON total");
        assert.equal(merged.output_tokens, expected.output_tokens);
      } else {
        writeJsonMessage(response, payload);
        actual = JSON.parse(response.chunks.at(-1)).usage;
      }
      assert.deepEqual(actual, streaming ? streamed : expected);
    });
  }
}

test("an interrupted stream keeps the request estimate as its usage anchor", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, { id: "msg-interrupted", inputTokens: 190000 });
  stream.start("gpt-6-sol");
  stream.handleSdkEvent({ type: "assistant.message_delta", data: { deltaContent: "partial reply" } });
  const events = sseEvents(response);
  assert.ok(!events.some((event) => event.type === "message_delta"));
  assert.equal(inputTotal(claudeCodeStreamUsage(events)), 190000);
});

test("serializes prior conversation for cold recovery", () => {
  const rendered = serializeConversation([
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.match(rendered, /USER: hello/);
  assert.match(rendered, /ASSISTANT: hi/);
});

test("default cold-recovery history retains messages larger than 256 KiB", () => {
  const messages = [
    { role: "user", content: "x".repeat(300 * 1024) },
    { role: "assistant", content: "retained reply" },
  ];
  const replay = serializeConversationTail(messages);

  assert.equal(replay.truncated, false);
  assert.equal(replay.text, serializeConversation(messages));
  assert.equal(serializeConversationTail(messages, 256 * 1024).truncated, true);
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
    input_tokens: 93,
    output_tokens: 20,
  });
});

test("never opens a content block from a tool call delta alone", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-2",
    inputTokens: 10,
  });
  stream.start("claude-haiku-4.5");
  stream.handleSdkEvent({
    type: "assistant.tool_call_delta",
    data: {
      toolCallId: "tool-1",
      toolName: "Read",
      inputDelta: '{"file_path":',
    },
  });

  // A content_block_start cannot be retracted once it is on the wire, and only
  // finish() knows which calls Copilot actually registered, so a delta - even a
  // named one carrying input - must leave the stream untouched.
  assert.doesNotMatch(response.chunks.join(""), /content_block_start/);
  assert.doesNotMatch(response.chunks.join(""), /tool_use/);
  assert.doesNotMatch(response.chunks.join(""), /file_path/);
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
    data: {
      toolCallId: "tool-1",
      toolName: "Read",
      inputDelta: '{"file_path":',
    },
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

  const events = sseEvents(response);
  // finish() frames the surviving call exactly once, so the delta cannot leave
  // a duplicate or half-named block behind it.
  assert.deepEqual(
    events
      .filter((data) => data.type === "content_block_start")
      .map((data) => data.content_block),
    [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
  );
  const partialJson = events
    .filter((data) => data.delta?.type === "input_json_delta")
    .map((data) => data.delta.partial_json)
    .join("");
  assert.deepEqual(JSON.parse(partialJson), { file_path: "/tmp/a" });
});

test("emits no tool_use bytes for a tool call Copilot never registers", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, {
    id: "msg-3",
    inputTokens: 10,
  });
  stream.start("claude-haiku-4.5");
  stream.handleSdkEvent({
    type: "assistant.tool_call_delta",
    data: { toolCallId: "ghost-1", toolName: "Read", inputDelta: "{" },
  });
  stream.finish({
    model: "claude-haiku-4.5",
    message: { content: "done", toolRequests: [], outputTokens: 1 },
  });

  // The dropped call must leave no trace: a framed tool_use with no input and
  // an "end_turn" stop reason hangs Claude Code waiting for a tool result.
  const output = response.chunks.join("");
  assert.doesNotMatch(output, /tool_use/);
  assert.doesNotMatch(output, /ghost-1/);
  const events = sseEvents(response);
  assert.deepEqual(
    events
      .filter((data) => data.type === "content_block_start")
      .map((data) => data.content_block.type),
    ["text"],
  );
  assert.equal(
    events.find((data) => data.type === "message_delta").delta.stop_reason,
    "end_turn",
  );
  assert.equal(response.ended, true);
});

// Native streams frame one block at a time: every content_block_start follows
// the previous block's content_block_stop, and indices count up from zero.
function assertStrictBlockNesting(events) {
  let open = null;
  let nextIndex = 0;
  for (const data of events) {
    if (data.type === "content_block_start") {
      assert.equal(open, null, `block ${data.index} opened while ${open} was open`);
      assert.equal(data.index, nextIndex++);
      open = data.index;
    } else if (data.type === "content_block_delta") {
      assert.equal(data.index, open, `delta for ${data.index} while ${open} was open`);
    } else if (data.type === "content_block_stop") {
      assert.equal(data.index, open, `stop for ${data.index} while ${open} was open`);
      open = null;
    } else if (["message_delta", "message_stop"].includes(data.type)) {
      assert.equal(open, null, `${data.type} while block ${open} was open`);
    }
  }
  assert.equal(open, null);
}

function blockFrames(events) {
  return events
    .filter((data) => data.type.startsWith("content_block_"))
    .map((data) => [data.type.slice("content_block_".length), data.index]);
}

test("stops each content block before the next one starts", () => {
  const response = fakeResponse();
  startSse(response);
  const stream = new AnthropicSseStream(response, { id: "msg-order", inputTokens: 10 });
  stream.start("gpt-6-astra");
  stream.handleSdkEvent({ type: "assistant.message_delta", data: { deltaContent: "Reading " } });
  stream.handleSdkEvent({ type: "assistant.message_delta", data: { deltaContent: "both." } });
  stream.finish({
    model: "gpt-6-astra",
    message: {
      content: "Reading both.",
      toolRequests: [
        { toolCallId: "tool-a", name: "Read", arguments: { file_path: "/tmp/a" } },
        { toolCallId: "tool-b", name: "Read", arguments: { file_path: "/tmp/b" } },
      ],
      outputTokens: 5,
    },
  });

  const events = sseEvents(response);
  assertStrictBlockNesting(events);
  // Each tool_use stops right after its input_json_delta.
  assert.deepEqual(blockFrames(events), [
    ["start", 0], ["delta", 0], ["delta", 0], ["stop", 0],
    ["start", 1], ["delta", 1], ["stop", 1],
    ["start", 2], ["delta", 2], ["stop", 2],
  ]);
  assert.equal(events.find((data) => data.type === "message_delta").delta.stop_reason, "tool_use");
});

test("keeps strict block nesting for tool-only, text-only and repeated-call turns", () => {
  for (const message of [
    { content: "", toolRequests: [{ toolCallId: "t1", name: "Bash", arguments: { command: "ls" } }] },
    { content: "plain answer", toolRequests: [] },
    {
      content: "twice",
      toolRequests: [
        { toolCallId: "dup", name: "Read", arguments: { file_path: "/tmp/a" } },
        { toolCallId: "dup", name: "Read", arguments: { file_path: "/tmp/a" } },
      ],
    },
  ]) {
    const response = fakeResponse();
    startSse(response);
    const stream = new AnthropicSseStream(response, { id: "msg-shapes", inputTokens: 10 });
    stream.finish({ model: "gpt-6-sol", message: { ...message, outputTokens: 1 } });

    const events = sseEvents(response);
    assertStrictBlockNesting(events);
    const starts = events.filter((data) => data.type === "content_block_start");
    const toolIds = starts.map((data) => data.content_block.id).filter(Boolean);
    assert.deepEqual(toolIds, [...new Set(message.toolRequests.map((tool) => tool.toolCallId))]);
    for (const { index } of starts.filter((data) => data.content_block.type === "tool_use")) {
      const input = events
        .filter((data) => data.index === index && data.delta?.type === "input_json_delta")
        .map((data) => data.delta.partial_json)
        .join("");
      assert.doesNotThrow(() => JSON.parse(input));
    }
    assert.equal(response.ended, true);
  }
});

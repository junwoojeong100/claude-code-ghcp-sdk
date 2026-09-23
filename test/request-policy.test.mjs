import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRequestPolicy,
  BridgeRequestError,
} from "../src/request-policy.mjs";

const tools = [
  { name: "Read", input_schema: { type: "object" } },
  { name: "Edit", input_schema: { type: "object" } },
];

test("tool_choice none removes every declared tool", () => {
  const body = applyRequestPolicy({
    tool_choice: { type: "none" },
    tools,
  });
  assert.deepEqual(body.tools, []);
});

test("tool_choice tool exposes only the selected tool", () => {
  const body = applyRequestPolicy({
    system: "system",
    tool_choice: { type: "tool", name: "Read" },
    tools,
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["Read"]);
  assert.match(body.system.at(-1).text, /must call the "Read" tool/);
});

test("tool_choice rejects unavailable tools", () => {
  assert.throws(
    () =>
      applyRequestPolicy({
        tool_choice: { type: "tool", name: "Bash" },
        tools,
      }),
    BridgeRequestError,
  );
});

test("reports provider controls that the Copilot SDK cannot represent", () => {
  const diagnostics = [];
  applyRequestPolicy(
    {
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.8,
    },
    (event) => diagnostics.push(event),
  );

  assert.deepEqual(diagnostics[0], {
    event: "bridge.degraded_controls",
    controls: ["temperature", "top_p", "max_tokens"],
    semantics: "not_exposed_by_copilot_sdk",
  });
});


test("reports accepted request fields the bridge ignores beside the degraded controls", () => {
  const diagnostics = [];
  const body = {
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    top_k: 5,
    metadata: { user_id: "user" },
    service_tier: "auto",
    speed: "fast",
    container: "container-1",
    mcp_servers: [],
    context_management: { edits: [] },
    output_config: { effort: "high", format: { type: "json_schema" }, task_budget: { type: "tokens", total: 64000 } },
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  };
  assert.equal(applyRequestPolicy(body, (event) => diagnostics.push(event)), body);

  assert.deepEqual(diagnostics, [{
    event: "bridge.degraded_controls",
    controls: ["max_tokens"],
    ignoredFields: [
      "thinking", "top_k", "metadata", "service_tier", "speed", "container",
      "mcp_servers", "context_management", "output_config.format",
      "output_config.task_budget", "tool_choice.disable_parallel_tool_use",
    ],
    semantics: "not_exposed_by_copilot_sdk",
  }]);
});

test("reports ignored fields alone and stays silent for fields the bridge uses", () => {
  const diagnostics = [];
  applyRequestPolicy({ metadata: { user_id: "user" } }, (event) => diagnostics.push(event));
  applyRequestPolicy({
    model: "gpt-6-astra",
    system: "system",
    messages: [],
    tools,
    stream: true,
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
  }, (event) => diagnostics.push(event));

  assert.deepEqual(diagnostics, [{
    event: "bridge.degraded_controls",
    controls: [],
    ignoredFields: ["metadata"],
    semantics: "not_exposed_by_copilot_sdk",
  }]);
});

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


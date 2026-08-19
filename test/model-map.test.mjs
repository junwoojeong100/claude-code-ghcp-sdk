import test from "node:test";
import assert from "node:assert/strict";

import {
  copilotModelForFrontend,
  frontendModelFor,
  resolveCopilotModel,
} from "../src/model-map.mjs";

const availableIds = [
  "claude-haiku-4.5",
  "claude-sonnet-4.6",
  "claude-opus-5",
  "gpt-5-mini",
];

test("maps Claude Code version syntax to Copilot model syntax", () => {
  assert.equal(copilotModelForFrontend("claude-sonnet-4-6"), "claude-sonnet-4.6");
  assert.equal(frontendModelFor("claude-sonnet-4.6"), "claude-sonnet-4-6");
});

test("resolves Claude family aliases", () => {
  assert.equal(
    resolveCopilotModel({ requested: "sonnet", availableIds }),
    "claude-sonnet-4.6",
  );
  assert.equal(
    resolveCopilotModel({ requested: "haiku", availableIds }),
    "claude-haiku-4.5",
  );
});

test("uses preferred Copilot model for unknown provider-specific names", () => {
  assert.equal(
    resolveCopilotModel({
      requested: "databricks-claude-sonnet-5[1m]",
      availableIds,
      preferredModel: "claude-sonnet-4.6",
    }),
    "claude-sonnet-4.6",
  );
});

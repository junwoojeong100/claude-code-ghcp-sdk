import test from "node:test";
import assert from "node:assert/strict";

import {
  adapterModels,
  contextWindowTokensFor,
  copilotModelForFrontend,
  frontendModelFor,
  gatewayModelEntries,
  pickerModelFor,
  resolveCopilotModel,
} from "../src/model-map.mjs";

const availableIds = [
  "claude-haiku-4.5",
  "claude-sonnet-4.6",
  "claude-opus-5",
  "gpt-5-mini",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

test("maps Claude Code version syntax to Copilot model syntax", () => {
  assert.equal(copilotModelForFrontend("claude-sonnet-4-6"), "claude-sonnet-4.6");
  assert.equal(frontendModelFor("claude-sonnet-4.6"), "claude-sonnet-4-6");
});

test("maps GPT 5.6 models to picker-safe Claude gateway IDs", () => {
  for (const variant of ["sol", "terra", "luna"]) {
    const copilotModel = `gpt-5.6-${variant}`;
    const pickerModel = `github-copilot/claude-gpt-5.6-${variant}`;
    assert.equal(frontendModelFor(copilotModel), copilotModel);
    assert.equal(pickerModelFor(copilotModel), pickerModel);
    assert.equal(copilotModelForFrontend(pickerModel), copilotModel);
    assert.equal(
      resolveCopilotModel({ requested: pickerModel, availableIds }),
      copilotModel,
    );
  }
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

test("exposes supported GPT 5.6 models with their Copilot context window", () => {
  const selected = adapterModels(availableIds.map((id) => ({ id })));
  assert.deepEqual(
    selected.map((model) => model.id),
    [
      "claude-haiku-4.5",
      "claude-sonnet-4.6",
      "claude-opus-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
  );
  assert.equal(contextWindowTokensFor("gpt-5.6-sol"), 1_050_000);
  assert.equal(contextWindowTokensFor("gpt-5.6-terra"), 1_050_000);
  assert.equal(contextWindowTokensFor("gpt-5.6-luna"), 1_050_000);
  assert.equal(
    contextWindowTokensFor("github-copilot/claude-gpt-5.6-sol"),
    1_050_000,
  );
  assert.equal(contextWindowTokensFor("claude-sonnet-4.6"), null);
});

test("formats GPT 5.6 models for Claude Code gateway discovery", () => {
  const entries = gatewayModelEntries([
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5-mini", name: "GPT-5 mini" },
  ]);
  assert.deepEqual(
    entries.map(({ id, backend_id, display_name }) => ({
      id,
      backend_id,
      display_name,
    })),
    [
      {
        id: "github-copilot/claude-gpt-5.6-sol",
        backend_id: "gpt-5.6-sol",
        display_name: "GitHub Copilot · GPT-5.6 Sol",
      },
      {
        id: "github-copilot/claude-gpt-5.6-terra",
        backend_id: "gpt-5.6-terra",
        display_name: "GitHub Copilot · GPT-5.6 Terra",
      },
      {
        id: "github-copilot/claude-gpt-5.6-luna",
        backend_id: "gpt-5.6-luna",
        display_name: "GitHub Copilot · GPT-5.6 Luna",
      },
    ],
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  adapterModels,
  contextWindowTokensFor,
  copilotModelForFrontend,
  frontendModelFor,
  gatewayModelEntries,
  ModelUnavailableError,
  pickerModelFor,
  resolveCopilotModel,
  resolveReasoningEffort,
} from "../src/model-map.mjs";

const availableIds = [
  "claude-haiku-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-opus-5",
  "claude-fable-5",
  "gpt-5-mini",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "example-model-3.6",
  "auto",
  "gpt-5-mini",
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

test("maps every non-Claude Copilot model through a picker-safe ID", () => {
  for (const copilotModel of ["gpt-5-mini", "example-model-3.6", "auto"]) {
    const pickerModel = `github-copilot/claude-${copilotModel}`;
    assert.equal(pickerModelFor(copilotModel), pickerModel);
    assert.equal(copilotModelForFrontend(pickerModel), copilotModel);
    assert.equal(
      resolveCopilotModel({ requested: pickerModel, availableIds }),
      copilotModel,
    );
  }
});

test("maps GPT 6 Astra launch and picker IDs without losing its context limit", () => {
  const model = "gpt-6-astra";
  const pickerModel = "github-copilot/claude-gpt-6-astra";
  assert.equal(frontendModelFor(model), model);
  assert.equal(pickerModelFor(model), pickerModel);

  for (const requested of [model, pickerModel, `${pickerModel}[1m]`]) {
    assert.equal(copilotModelForFrontend(requested), model);
    assert.equal(resolveCopilotModel({ requested, availableIds }), model);
    assert.equal(contextWindowTokensFor(requested), 1_178_000);
    assert.throws(
      () =>
        resolveCopilotModel({
          requested,
          availableIds: ["claude-sonnet-5"],
          preferredModel: "claude-sonnet-5",
        }),
      ModelUnavailableError,
    );
  }
});

test("resolves Claude family aliases", () => {
  assert.equal(
    resolveCopilotModel({ requested: "sonnet", availableIds }),
    "claude-sonnet-5",
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
      preferredModel: "claude-sonnet-5",
    }),
    "claude-sonnet-5",
  );
});

test("does not silently replace an explicit unavailable model", () => {
  assert.throws(
    () =>
      resolveCopilotModel({
        requested: "gpt-does-not-exist",
        availableIds,
        preferredModel: "claude-sonnet-5",
      }),
    ModelUnavailableError,
  );
  assert.throws(
    () =>
      resolveCopilotModel({
        requested: "claude-sonnet-99",
        availableIds,
        preferredModel: "claude-sonnet-5",
      }),
    ModelUnavailableError,
  );
});

test("uses the preferred model for an explicit default request", () => {
  assert.equal(
    resolveCopilotModel({
      requested: "default",
      availableIds,
      preferredModel: "claude-sonnet-5",
    }),
    "claude-sonnet-5",
  );
});

test("lists every visible Copilot model once", () => {
  const selected = adapterModels(availableIds.map((id) => ({ id })));
  assert.deepEqual(
    selected.map((model) => model.id),
    [
      "claude-haiku-4.5",
      "claude-sonnet-5",
      "claude-sonnet-4.6",
      "claude-opus-5",
      "gpt-5-mini",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "example-model-3.6",
      "auto",
    ],
  );
  assert.equal(contextWindowTokensFor("gpt-5.6-sol"), 1_050_000);
  assert.equal(contextWindowTokensFor("gpt-5.6-terra"), 1_050_000);
  assert.equal(contextWindowTokensFor("gpt-5.6-luna"), 1_050_000);
  assert.equal(
    contextWindowTokensFor("github-copilot/claude-gpt-5.6-sol"),
    1_050_000,
  );
  assert.equal(contextWindowTokensFor("claude-sonnet-5"), null);
});

test("formats available Copilot adapter models for gateway discovery", () => {
  const millionContext = {
    limits: { max_context_window_tokens: 1_000_000 },
  };
  const extendedContext = {
    limits: { max_context_window_tokens: 1_050_000 },
  };
  const entries = gatewayModelEntries([
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      capabilities: millionContext,
    },
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      capabilities: millionContext,
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      capabilities: millionContext,
    },
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      capabilities: millionContext,
    },
    {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      capabilities: millionContext,
    },
    {
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
      capabilities: millionContext,
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      capabilities: {
        limits: { max_context_window_tokens: 200_000 },
      },
    },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      capabilities: extendedContext,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      capabilities: extendedContext,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      capabilities: extendedContext,
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      capabilities: {
        limits: { max_context_window_tokens: 1_178_000 },
      },
    },
    { id: "gpt-5-mini", name: "GPT-5 mini" },
    { id: "example-model-3.6", name: "Example Model 3.6" },
    { id: "auto", name: "Auto" },
    { id: "gpt-5-mini", name: "GPT-5 mini duplicate" },
  ]);
  assert.deepEqual(
    entries.map(({ id, backend_id, display_name }) => ({
      id,
      backend_id,
      display_name,
    })),
    [
      {
        id: "claude-opus-4-7[1m]",
        backend_id: "claude-opus-4.7",
        display_name:
          "GitHub Copilot · Claude Opus 4.7 (claude-opus-4.7)",
      },
      {
        id: "claude-opus-4-6[1m]",
        backend_id: "claude-opus-4.6",
        display_name:
          "GitHub Copilot · Claude Opus 4.6 (claude-opus-4.6)",
      },
      {
        id: "github-copilot/claude-gpt-5.6-sol[1m]",
        backend_id: "gpt-5.6-sol",
        display_name: "GitHub Copilot · GPT-5.6 Sol (gpt-5.6-sol)",
      },
      {
        id: "github-copilot/claude-gpt-5.6-terra[1m]",
        backend_id: "gpt-5.6-terra",
        display_name: "GitHub Copilot · GPT-5.6 Terra (gpt-5.6-terra)",
      },
      {
        id: "github-copilot/claude-gpt-5.6-luna[1m]",
        backend_id: "gpt-5.6-luna",
        display_name: "GitHub Copilot · GPT-5.6 Luna (gpt-5.6-luna)",
      },
      {
        id: "github-copilot/claude-gpt-6-astra[1m]",
        backend_id: "gpt-6-astra",
        display_name: "GitHub Copilot · GPT-6 Astra (gpt-6-astra)",
      },
      {
        id: "github-copilot/claude-gpt-5-mini",
        backend_id: "gpt-5-mini",
        display_name: "GitHub Copilot · GPT-5 mini (gpt-5-mini)",
      },
      {
        id: "github-copilot/claude-example-model-3.6",
        backend_id: "example-model-3.6",
        display_name:
          "GitHub Copilot · Example Model 3.6 (example-model-3.6)",
      },
      {
        id: "github-copilot/claude-auto",
        backend_id: "auto",
        display_name: "GitHub Copilot · Auto (auto)",
      },
    ],
  );
  assert.equal(
    copilotModelForFrontend("claude-opus-4-7[1m]"),
    "claude-opus-4.7",
  );
  assert.equal(
    copilotModelForFrontend("github-copilot/claude-gpt-5.6-sol[1m]"),
    "gpt-5.6-sol",
  );
});

test("validates reasoning effort against Copilot model capabilities", () => {
  const model = {
    id: "gpt-5.6-sol",
    capabilities: {
      supports: { reasoningEffort: true },
      supportedReasoningEfforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    },
  };

  assert.equal(resolveReasoningEffort({ requested: "xhigh", model }), "xhigh");
  assert.equal(
    resolveReasoningEffort({
      requested: "max",
      model: {
        id: "gpt-5.5",
        capabilities: {
          supports: { reasoningEffort: true },
          supportedReasoningEfforts: [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
          ],
        },
      },
    }),
    "xhigh",
  );
  assert.equal(
    resolveReasoningEffort({
      requested: "xhigh",
      model: {
        id: "claude-opus-4.6",
        capabilities: {
          supports: { reasoningEffort: true },
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
        },
      },
    }),
    "high",
  );
  assert.equal(
    resolveReasoningEffort({
      requested: "high",
      model: {
        id: "claude-haiku-4.5",
        capabilities: { supports: { reasoningEffort: false } },
      },
    }),
    null,
  );
  assert.throws(
    () => resolveReasoningEffort({ requested: "extreme", model }),
    /Supported reasoning efforts: none, low, medium, high, xhigh, max/,
  );
});

test("respects the reasoning effort levels advertised by the SDK for Astra", () => {
  const model = {
    id: "gpt-6-astra",
    capabilities: {
      supports: {
        reasoningEffort: true,
        reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
      },
    },
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  };

  assert.equal(resolveReasoningEffort({ requested: "xhigh", model }), "xhigh");
  assert.equal(resolveReasoningEffort({ requested: "max", model }), "xhigh");
  assert.equal(resolveReasoningEffort({ requested: "none", model }), "low");
});

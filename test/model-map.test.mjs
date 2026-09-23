import test from "node:test";
import assert from "node:assert/strict";

import {
  adapterModels,
  contextWindowTokensFor,
  copilotModelForFrontend,
  frontendModelFor,
  gatewayModelEntries,
  launchModelFor,
  ModelUnavailableError,
  pickerModelFor,
  primaryModelPicker,
  PRIMARY_MODELS,
  resolveCopilotModel,
  resolveReasoningEffort,
  sdkContextOptionsFor,
} from "../src/model-map.mjs";

const availableIds = [
  "claude-haiku-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-fable-5",
  "gpt-5-mini",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "example-model-3.6",
  "auto",
  "gpt-5-mini",
];

const PRIMARY_GPT_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const RETAINED_GPT_56_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const MILLION_CLAUDE_MODELS = ["claude-opus-5.5", "claude-sonnet-5"];

test("1M primaries and retained GPT-5.6 models opt into SDK long context using only advertised numeric limits", () => {
  for (const id of [...PRIMARY_GPT_MODELS, ...RETAINED_GPT_56_MODELS, ...MILLION_CLAUDE_MODELS]) {
    const limits = { max_context_window_tokens: 1178000, max_prompt_tokens: 1050000, max_output_tokens: 128000 };
    assert.deepEqual(sdkContextOptionsFor({ id, capabilities: { limits: { ...limits, unrelated: "not-forwarded" } } }), {
      contextTier: "long_context", modelCapabilities: { limits },
    });
  }
  for (const model of [
    { id: "gpt-6-astra" },
    { id: "gpt-6-astra", capabilities: { limits: { max_context_window_tokens: 200000 } } },
    { id: "claude-haiku-4.5", capabilities: { limits: { max_context_window_tokens: 200000 } } },
    // A 1M Claude model stays on the default tier when its catalogue entry reports less.
    { id: "claude-opus-5.5", capabilities: { limits: { max_context_window_tokens: 200000 } } },
    { id: "unverified-model", capabilities: { limits: { max_context_window_tokens: 1000000 } } },
  ]) assert.deepEqual(sdkContextOptionsFor(model), {});
  assert.deepEqual(sdkContextOptionsFor({ id: "gpt-6-astra", capabilities: { limits: {
    max_context_window_tokens: 1178000, max_prompt_tokens: -1, max_output_tokens: "128000",
  } } }), { contextTier: "long_context", modelCapabilities: { limits: { max_context_window_tokens: 1178000 } } });
});

test("maps Claude Code version syntax to Copilot model syntax", () => {
  assert.equal(copilotModelForFrontend("claude-sonnet-4-6"), "claude-sonnet-4.6");
  assert.equal(frontendModelFor("claude-sonnet-4.6"), "claude-sonnet-4-6");
});

test("maps retained GPT 5.6 models to picker-safe Claude gateway IDs", () => {
  for (const copilotModel of RETAINED_GPT_56_MODELS) {
    const pickerModel = `github-copilot/claude-${copilotModel}`;
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

test("maps GPT-6 launch and picker IDs without losing their catalogue context limits", () => {
  const contextWindows = { "gpt-6-astra": 1_050_000, "gpt-6-sol": 1_000_000, "gpt-6-luna": 1_000_000 };
  for (const model of PRIMARY_GPT_MODELS) {
    const pickerModel = `github-copilot/claude-${model}`;
    assert.equal(frontendModelFor(model), model);
    assert.equal(pickerModelFor(model), pickerModel);

    for (const requested of [model, pickerModel, `${pickerModel}[1m]`]) {
      assert.equal(copilotModelForFrontend(requested), model);
      assert.equal(resolveCopilotModel({ requested, availableIds }), model);
      assert.equal(contextWindowTokensFor(requested), contextWindows[model]);
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
  }
});

test("maps Claude Opus 5.5 between Claude Code and Copilot version syntax", () => {
  assert.equal(frontendModelFor("claude-opus-5.5"), "claude-opus-5-5");
  assert.equal(pickerModelFor("claude-opus-5.5"), "claude-opus-5-5");
  for (const requested of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-5.5"]) {
    assert.equal(copilotModelForFrontend(requested), "claude-opus-5.5");
    assert.equal(resolveCopilotModel({ requested, availableIds }), "claude-opus-5.5");
  }
  assert.equal(contextWindowTokensFor("claude-opus-5.5"), 1_000_000);
  assert.equal(launchModelFor("claude-opus-5.5"), "claude-opus-5-5[1m]");
});

test("resolves Claude family aliases", () => {
  assert.equal(
    resolveCopilotModel({ requested: "opus", availableIds }),
    "claude-opus-5.5",
  );
  assert.equal(
    resolveCopilotModel({
      requested: "opus",
      availableIds: availableIds.filter((id) => id !== "claude-opus-5.5"),
    }),
    "claude-opus-5",
  );
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
      "claude-opus-5.5",
      "claude-opus-5",
      "gpt-5-mini",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
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
  assert.equal(contextWindowTokensFor("gpt-6-sol"), 1_000_000);
  assert.equal(contextWindowTokensFor("github-copilot/claude-gpt-6-luna"), 1_000_000);
  assert.equal(contextWindowTokensFor("claude-sonnet-5"), 1_000_000);
  assert.equal(contextWindowTokensFor("claude-haiku-4.5"), null);
});

test("gateway discovery includes only primary models without duplicating native rows", () => {
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
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
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
      capabilities: extendedContext,
    },
    {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      capabilities: millionContext,
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      capabilities: millionContext,
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
        id: "github-copilot/claude-gpt-6-astra[1m]",
        backend_id: "gpt-6-astra",
        display_name: "GitHub Copilot · GPT-6 Astra (gpt-6-astra)",
      },
      {
        id: "github-copilot/claude-gpt-6-sol[1m]",
        backend_id: "gpt-6-sol",
        display_name: "GitHub Copilot · GPT-6 Sol (gpt-6-sol)",
      },
      {
        id: "github-copilot/claude-gpt-6-luna[1m]",
        backend_id: "gpt-6-luna",
        display_name: "GitHub Copilot · GPT-6 Luna (gpt-6-luna)",
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

test("the native picker replaces all other lineups with the six verified models", () => {
  const picker = primaryModelPicker();
  assert.equal(picker.replaceBuiltInOptions, true);
  assert.equal(picker.options.length, 6);
  assert.deepEqual(picker.options.map((option) => copilotModelForFrontend(option.model)), [
    "claude-opus-5.5", "claude-sonnet-5", "claude-haiku-4.5",
    "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  ]);
  assert.deepEqual(picker.options.map((option) => option.model), [
    "claude-opus-5-5[1m]", "claude-sonnet-5[1m]", "claude-haiku-4-5",
    "github-copilot/claude-gpt-6-astra[1m]",
    "github-copilot/claude-gpt-6-sol[1m]",
    "github-copilot/claude-gpt-6-luna[1m]",
  ]);
  assert.deepEqual(PRIMARY_MODELS, picker.options.map((option) => copilotModelForFrontend(option.model)));
  assert.ok(picker.options.every((option) => option.label.startsWith("GitHub Copilot")));
  for (const retired of ["claude-opus-5", ...RETAINED_GPT_56_MODELS]) {
    assert.ok(!PRIMARY_MODELS.includes(retired), `${retired} must not be pinned`);
    assert.equal(resolveCopilotModel({ requested: retired, availableIds }), retired);
  }
  assert.equal(resolveCopilotModel({ requested: "gpt-5-mini", availableIds }), "gpt-5-mini");
});

test("launch context hints stay with their models rather than a global window override", () => {
  for (const model of [...PRIMARY_GPT_MODELS, ...RETAINED_GPT_56_MODELS]) {
    const value = `github-copilot/claude-${model}[1m]`;
    assert.equal(launchModelFor(model), value);
    assert.equal(launchModelFor(value), value);
    assert.equal(copilotModelForFrontend(value), model);
  }
  assert.equal(launchModelFor("claude-opus-5.5"), "claude-opus-5-5[1m]");
  assert.equal(launchModelFor("claude-haiku-4.5"), "claude-haiku-4-5");
  assert.equal(launchModelFor("claude-sonnet-5"), "claude-sonnet-5[1m]");
  assert.equal(launchModelFor("gpt-5-mini"), "gpt-5-mini");
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

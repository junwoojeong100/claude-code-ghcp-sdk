const FAMILY_CANDIDATES = {
  fable: ["claude-fable-5"],
  opus: [
    "claude-opus-5",
    "claude-opus-4.8",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-opus-4.5",
  ],
  sonnet: ["claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5"],
  haiku: ["claude-haiku-4.5"],
};

const GPT_56_CONTEXT_WINDOW_TOKENS = 1_050_000;
const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;
const COPILOT_PICKER_PREFIX = "github-copilot/claude-";
const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const CLAUDE_CODE_BUILT_IN_MODELS = new Set([
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
]);
const MODEL_CONTEXT_WINDOW_TOKENS = new Map(
  ["sol", "terra", "luna"].map((variant) => [
    `gpt-5.6-${variant}`,
    GPT_56_CONTEXT_WINDOW_TOKENS,
  ]),
);

function isAdapterModelId(modelId) {
  return typeof modelId === "string" && modelId.length > 0;
}

function isVisibleAdapterModelId(modelId) {
  return isAdapterModelId(modelId) && !modelId.startsWith("claude-fable-");
}

export class ModelUnavailableError extends Error {
  constructor(requested, availableIds) {
    const supportedIds = [
      ...new Set(availableIds.filter(isVisibleAdapterModelId)),
    ];
    super(
      `GitHub Copilot model "${requested}" is unavailable. ` +
        `Available adapter models: ${supportedIds.join(", ") || "none"}.`,
    );
    this.name = "ModelUnavailableError";
  }
}

export class ReasoningEffortUnavailableError extends Error {
  constructor(requested, modelId, supported) {
    super(
      `GitHub Copilot model "${modelId}" does not support reasoning effort "${requested}". ` +
        `Supported reasoning efforts: ${supported.join(", ") || "none"}.`,
    );
    this.name = "ReasoningEffortUnavailableError";
  }
}

export function stripContextSuffix(model) {
  return String(model || "").trim().replace(/\[(?:1m|\d+k)\]$/i, "");
}

export function frontendModelFor(copilotModel) {
  const model = stripContextSuffix(copilotModel);
  return model.replace(
    /^(claude-(?:haiku|sonnet|opus))-(\d+)\.(\d+)$/,
    "$1-$2-$3",
  );
}

export function pickerModelFor(copilotModel) {
  const model = stripContextSuffix(copilotModel);
  if (model.startsWith(COPILOT_PICKER_PREFIX)) return model;
  return model.startsWith("claude-")
    ? frontendModelFor(model)
    : `${COPILOT_PICKER_PREFIX}${model}`;
}

export function copilotModelForFrontend(frontendModel) {
  const model = stripContextSuffix(frontendModel);
  if (model.startsWith(COPILOT_PICKER_PREFIX)) {
    return model.slice(COPILOT_PICKER_PREFIX.length);
  }
  return model.replace(
    /^(claude-(?:haiku|sonnet|opus))-(\d+)-(\d+)$/,
    "$1-$2.$3",
  );
}

export function resolveCopilotModel({
  requested,
  availableIds,
  preferredModel,
}) {
  const available = new Set(availableIds);
  const raw = stripContextSuffix(requested);

  if (
    (!raw || raw === "default") &&
    preferredModel &&
    available.has(preferredModel)
  ) {
    return preferredModel;
  }
  if (available.has(raw)) return raw;

  const converted = copilotModelForFrontend(raw);
  if (available.has(converted)) return converted;

  const embeddedClaudeModel = raw.match(
    /claude-(?:fable|opus|sonnet|haiku)-\d+(?:[.-]\d+)?/i,
  )?.[0];
  if (embeddedClaudeModel) {
    const embeddedConverted = copilotModelForFrontend(embeddedClaudeModel);
    if (available.has(embeddedConverted)) return embeddedConverted;
  }

  const family = ["fable", "opus", "sonnet", "haiku"].includes(
    raw.toLowerCase(),
  )
    ? raw.toLowerCase()
    : null;
  if (family) {
    const familyMatch = FAMILY_CANDIDATES[family].find((candidate) =>
      available.has(candidate),
    );
    if (familyMatch) return familyMatch;
  }

  throw new ModelUnavailableError(requested, availableIds);
}

export function resolveReasoningEffort({ requested, model }) {
  if (!requested) return null;

  const supported = [
    ...new Set(
      [
        ...(model?.supportedReasoningEfforts || []),
        ...(model?.capabilities?.supportedReasoningEfforts || []),
      ],
    ),
  ];
  const configurable =
    model?.capabilities?.supports?.reasoningEffort ?? supported.length > 0;

  if (!configurable) return null;
  if (!supported.length || supported.includes(requested)) return requested;

  const requestedIndex = REASONING_EFFORT_LEVELS.indexOf(requested);
  if (requestedIndex < 0) {
    throw new ReasoningEffortUnavailableError(
      requested,
      model?.id || "unknown",
      supported,
    );
  }

  const orderedSupported = REASONING_EFFORT_LEVELS.filter((effort) =>
    supported.includes(effort),
  );
  return (
    orderedSupported.findLast(
      (effort) => REASONING_EFFORT_LEVELS.indexOf(effort) <= requestedIndex,
    ) ??
    orderedSupported[0] ??
    null
  );
}

export function adapterModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (!isVisibleAdapterModelId(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function gatewayPickerId(model) {
  const pickerId = pickerModelFor(model.id);
  const contextWindowTokens =
    model.capabilities?.limits?.max_context_window_tokens;
  const nativeMillionContext = /^claude-(?:opus|sonnet)-5$/.test(model.id);

  return contextWindowTokens >= ONE_MILLION_CONTEXT_TOKENS &&
    !nativeMillionContext
    ? `${pickerId}[1m]`
    : pickerId;
}

function gatewayDisplayName(model) {
  const name = model.name || model.id;
  const label = name === model.id ? name : `${name} (${model.id})`;
  return `GitHub Copilot · ${label}`;
}

export function gatewayModelEntries(models) {
  return adapterModels(models)
    .filter((model) => !CLAUDE_CODE_BUILT_IN_MODELS.has(model.id))
    .map((model) => ({
      id: gatewayPickerId(model),
      backend_id: model.id,
      display_name: gatewayDisplayName(model),
      object: "model",
      owned_by: "github-copilot",
      capabilities: model.capabilities,
    }));
}

export function contextWindowTokensFor(model) {
  const copilotModel = copilotModelForFrontend(model);
  return MODEL_CONTEXT_WINDOW_TOKENS.get(copilotModel) ?? null;
}

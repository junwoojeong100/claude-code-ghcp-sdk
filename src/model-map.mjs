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

const ADDITIONAL_MODEL_CONTEXT_WINDOWS = new Map([
  ["gpt-5.6-sol", 1_050_000],
  ["gpt-5.6-terra", 1_050_000],
  ["gpt-5.6-luna", 1_050_000],
]);

const COPILOT_TO_FRONTEND_MODEL = new Map([
  ["gpt-5.6-sol", "github-copilot/claude-gpt-5.6-sol"],
  ["gpt-5.6-terra", "github-copilot/claude-gpt-5.6-terra"],
  ["gpt-5.6-luna", "github-copilot/claude-gpt-5.6-luna"],
]);

const FRONTEND_TO_COPILOT_MODEL = new Map(
  [...COPILOT_TO_FRONTEND_MODEL].map(([copilot, frontend]) => [
    frontend,
    copilot,
  ]),
);

export class ModelUnavailableError extends Error {
  constructor(requested, availableIds) {
    const supported = adapterModels(availableIds.map((id) => ({ id })));
    super(
      `GitHub Copilot model "${requested}" is unavailable. ` +
        `Available adapter models: ${supported.map((model) => model.id).join(", ") || "none"}.`,
    );
    this.name = "ModelUnavailableError";
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
  return COPILOT_TO_FRONTEND_MODEL.get(model) || frontendModelFor(model);
}

export function copilotModelForFrontend(frontendModel) {
  const model = stripContextSuffix(frontendModel);
  const copilotModel = FRONTEND_TO_COPILOT_MODEL.get(model);
  if (copilotModel) return copilotModel;
  return model.replace(
    /^(claude-(?:haiku|sonnet|opus))-(\d+)-(\d+)$/,
    "$1-$2.$3",
  );
}

function familyFor(model) {
  const value = stripContextSuffix(model).toLowerCase();
  if (value === "fable" || value.includes("fable")) return "fable";
  if (value === "opus" || value.includes("opus")) return "opus";
  if (value === "sonnet" || value.includes("sonnet")) return "sonnet";
  if (value === "haiku" || value.includes("haiku")) return "haiku";
  return null;
}

function firstAvailable(candidates, available) {
  return candidates.find((candidate) => available.has(candidate));
}

export function resolveCopilotModel({
  requested,
  availableIds,
  preferredModel,
}) {
  const available = new Set(availableIds);
  const raw = stripContextSuffix(requested);

  if (available.has(raw)) return raw;

  const converted = copilotModelForFrontend(raw);
  if (available.has(converted)) return converted;

  const family = familyFor(raw);
  if (family) {
    const familyMatch = firstAvailable(FAMILY_CANDIDATES[family], available);
    if (familyMatch) return familyMatch;
  }

  if (preferredModel && available.has(preferredModel)) return preferredModel;

  throw new ModelUnavailableError(requested, availableIds);
}

export function familyFrontendModels(availableIds, preferredModel) {
  const available = new Set(availableIds);
  const pick = (family) =>
    firstAvailable(FAMILY_CANDIDATES[family], available) ||
    (preferredModel && available.has(preferredModel) ? preferredModel : null);

  return {
    fable: frontendModelFor(pick("fable") || preferredModel),
    opus: frontendModelFor(pick("opus") || preferredModel),
    sonnet: frontendModelFor(pick("sonnet") || preferredModel),
    haiku: frontendModelFor(pick("haiku") || preferredModel),
  };
}

export function adapterModels(models) {
  return models.filter(
    (model) =>
      model.id.startsWith("claude-") ||
      ADDITIONAL_MODEL_CONTEXT_WINDOWS.has(model.id),
  );
}

export function gatewayModelEntries(models) {
  return models
    .filter((model) => ADDITIONAL_MODEL_CONTEXT_WINDOWS.has(model.id))
    .map((model) => ({
      id: pickerModelFor(model.id),
      backend_id: model.id,
      display_name: `GitHub Copilot · ${model.name || model.id}`,
      object: "model",
      owned_by: "github-copilot",
      capabilities: model.capabilities,
    }));
}

export function contextWindowTokensFor(model) {
  const normalized = stripContextSuffix(model);
  const copilotModel = FRONTEND_TO_COPILOT_MODEL.get(normalized) || normalized;
  return ADDITIONAL_MODEL_CONTEXT_WINDOWS.get(copilotModel) || null;
}

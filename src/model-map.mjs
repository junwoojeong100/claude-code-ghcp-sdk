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

export class ModelUnavailableError extends Error {
  constructor(requested, availableIds) {
    super(
      `GitHub Copilot model "${requested}" is unavailable. ` +
        `Available Claude models: ${availableIds.filter((id) => id.startsWith("claude-")).join(", ") || "none"}.`,
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

export function copilotModelForFrontend(frontendModel) {
  const model = stripContextSuffix(frontendModel);
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

export function claudeModels(models) {
  return models.filter((model) => model.id.startsWith("claude-"));
}

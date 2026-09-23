import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLAUDE_PROVIDER_SELECTORS = Object.freeze([
  "CLAUDE_CODE_USE_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
]);

export const CLAUDE_INHERITED_MODEL_OPTIONS = Object.freeze([
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
]);

export const CLAUDE_GATEWAY_ENV_OVERRIDES = Object.freeze({
  ...Object.fromEntries(CLAUDE_PROVIDER_SELECTORS.map((name) => [name, ""])),
  ...Object.fromEntries(
    CLAUDE_INHERITED_MODEL_OPTIONS.map((name) => [name, ""]),
  ),
  ENABLE_TOOL_SEARCH: "",
});

export function createGatewaySettings({
  baseUrl,
  token,
  model,
  familyModels,
  displayNames,
  description,
  modelPicker,
  extraEnv = {},
}) {
  const usesFamilyModel = Object.values(familyModels).includes(model);
  const customModelEnv = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: usesFamilyModel ? "" : model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: usesFamilyModel
      ? ""
      : displayNames.custom,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: usesFamilyModel
      ? ""
      : description,
  };
  const subagentModelEnv = {
    // Model-less subagents (general-purpose, custom agents) follow this; a
    // blank value also keeps an inherited shell value from leaking in.
    CLAUDE_CODE_SUBAGENT_MODEL: usesFamilyModel ? "" : model,
    // Claude Code caps Explore's "inherit" at the opus alias whenever the main
    // model name is not haiku/sonnet/opus, which sent a GPT session's Explore
    // to the Opus family model. Claude main models never hit the cap.
    CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP: "1",
  };

  return {
    ...(modelPicker ? { modelPicker } : {}),
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: familyModels.opus,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: displayNames.opus,
      ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: description,
      ANTHROPIC_DEFAULT_SONNET_MODEL: familyModels.sonnet,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: displayNames.sonnet,
      ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: description,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: familyModels.haiku,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: displayNames.haiku,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: description,
      ANTHROPIC_SMALL_FAST_MODEL: familyModels.haiku,
      ...customModelEnv,
      ...subagentModelEnv,
      ...CLAUDE_GATEWAY_ENV_OVERRIDES,
      ...extraEnv,
    },
  };
}

export function writeGatewaySettings(outputPath, options) {
  const settings = createGatewaySettings(options);
  // The file carries the bridge token; an existing file keeps its old mode
  // unless we chmod it, and the daemon-owned parent may not exist yet.
  mkdirSync(path.dirname(outputPath), { mode: 0o700, recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(outputPath, 0o600);
}

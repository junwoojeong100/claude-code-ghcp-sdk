import { writeFileSync } from "node:fs";

export const CLAUDE_PROVIDER_SELECTORS = Object.freeze([
  "CLAUDE_CODE_USE_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
]);

export const CLAUDE_GATEWAY_ENV_OVERRIDES = Object.freeze({
  ...Object.fromEntries(CLAUDE_PROVIDER_SELECTORS.map((name) => [name, ""])),
  ENABLE_TOOL_SEARCH: "",
});

export function createGatewaySettings({
  baseUrl,
  token,
  model,
  familyModels,
  displayNames,
  description,
  extraEnv = {},
}) {
  const customModelEnv = Object.values(familyModels).includes(model)
    ? {}
    : {
        ANTHROPIC_CUSTOM_MODEL_OPTION: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: displayNames.custom,
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: description,
      };

  return {
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
      ...CLAUDE_GATEWAY_ENV_OVERRIDES,
      ...extraEnv,
    },
  };
}

export function writeGatewaySettings(outputPath, options) {
  const settings = createGatewaySettings(options);
  writeFileSync(outputPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

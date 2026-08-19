import fs from "node:fs";

import { contextWindowTokensFor } from "./model-map.mjs";

const [outputPath, baseUrl, token, frontendModel] = process.argv.slice(2);
if (!outputPath || !baseUrl || !token || !frontendModel) {
  console.error(
    "Usage: node src/write-launch-settings.mjs <output> <base-url> <token> <frontend-model>",
  );
  process.exit(2);
}

const contextWindowTokens = contextWindowTokensFor(frontendModel);
const settings = {
  env: {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: frontendModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "GitHub Copilot Claude Fable 5",
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: "Routed through GitHub Copilot SDK",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "GitHub Copilot Claude Opus",
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "Routed through GitHub Copilot SDK",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "GitHub Copilot Claude Sonnet",
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "Routed through GitHub Copilot SDK",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "GitHub Copilot Claude Haiku",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: "Routed through GitHub Copilot SDK",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_CUSTOM_MODEL_OPTION: frontendModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: `GitHub Copilot ${frontendModel}`,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Routed through GitHub Copilot SDK",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(contextWindowTokens
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindowTokens) }
      : {}),
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600,
});

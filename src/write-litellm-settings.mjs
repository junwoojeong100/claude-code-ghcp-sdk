import fs from "node:fs";

const [outputPath, baseUrlValue, model] = process.argv.slice(2);
const token = process.env.LITELLM_API_KEY;

if (!outputPath || !baseUrlValue || !model || !token) {
  console.error(
    "Usage: LITELLM_API_KEY=... node src/write-litellm-settings.mjs " +
      "<output> <base-url> <model>",
  );
  process.exit(2);
}

let baseUrl;
try {
  const parsed = new URL(baseUrlValue);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("URL must not contain a query string or fragment");
  }
  if (parsed.pathname.replace(/\/+$/, "").endsWith("/v1")) {
    throw new Error("URL must not end in /v1; Claude Code appends /v1/messages");
  }
  baseUrl = baseUrlValue.replace(/\/+$/, "");
} catch (error) {
  console.error(`Invalid LiteLLM base URL: ${error.message}`);
  process.exit(2);
}

const opusModel = process.env.LITELLM_OPUS_MODEL || model;
const sonnetModel = process.env.LITELLM_SONNET_MODEL || model;
const haikuModel = process.env.LITELLM_HAIKU_MODEL || model;
const fableModel = process.env.LITELLM_FABLE_MODEL || model;

const settings = {
  env: {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: fableModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: `LiteLLM ${fableModel}`,
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: "Routed through LiteLLM",
    ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: `LiteLLM ${opusModel}`,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "Routed through LiteLLM",
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: `LiteLLM ${sonnetModel}`,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "Routed through LiteLLM",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: `LiteLLM ${haikuModel}`,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: "Routed through LiteLLM",
    ANTHROPIC_SMALL_FAST_MODEL: haikuModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: `LiteLLM ${model}`,
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Routed through LiteLLM",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(settings, null, 2)}\n`, {
  mode: 0o600,
});

import { writeGatewaySettings } from "./claude-gateway-env.mjs";

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

const familyModels = {
  opus: process.env.LITELLM_OPUS_MODEL || model,
  sonnet: process.env.LITELLM_SONNET_MODEL || model,
  haiku: process.env.LITELLM_HAIKU_MODEL || model,
};
writeGatewaySettings(outputPath, {
  baseUrl,
  token,
  model,
  familyModels,
  displayNames: {
    opus: `LiteLLM · ${familyModels.opus}`,
    sonnet: `LiteLLM · ${familyModels.sonnet}`,
    haiku: `LiteLLM · ${familyModels.haiku}`,
    custom: `LiteLLM · ${model}`,
  },
  description: "Routed through LiteLLM",
  extraEnv: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
});

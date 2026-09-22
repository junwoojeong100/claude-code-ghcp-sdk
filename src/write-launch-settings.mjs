import { writeGatewaySettings } from "./claude-gateway-env.mjs";
import { launchModelFor, primaryModelPicker } from "./model-map.mjs";

const [outputPath, baseUrl, token, frontendModel] = process.argv.slice(2);
if (!outputPath || !baseUrl || !token || !frontendModel) {
  console.error(
    "Usage: node src/write-launch-settings.mjs <output> <base-url> <token> <frontend-model>",
  );
  process.exit(2);
}

const nativeToolSearch = process.env.GHCP_NATIVE_TOOL_SEARCH ?? "0";
if (!["0", "1"].includes(nativeToolSearch)) {
  throw new Error("GHCP_NATIVE_TOOL_SEARCH must be 0 or 1.");
}
writeGatewaySettings(outputPath, {
  baseUrl,
  token,
  model: launchModelFor(frontendModel),
  modelPicker: primaryModelPicker(),
  familyModels: {
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
  },
  displayNames: {
    opus: "GitHub Copilot Claude Opus 5",
    sonnet: "GitHub Copilot Claude Sonnet 5",
    haiku: "GitHub Copilot Claude Haiku 4.5",
    custom: `GitHub Copilot ${frontendModel}`,
  },
  description: "Routed through GitHub Copilot SDK",
  extraEnv: {
    ENABLE_TOOL_SEARCH: nativeToolSearch === "1" ? "true" : "",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Context belongs to the selected model, not the model used at startup.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "",
  },
});

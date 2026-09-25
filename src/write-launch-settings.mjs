import { writeGatewaySettings } from "./claude-gateway-env.mjs";
import { launchModelFor, primaryModelPicker } from "./model-map.mjs";

// The token comes only from the environment: argv is readable by every local
// user through the process table. A fourth argument is an old caller still
// passing the token there, so it fails instead of leaking.
const [outputPath, baseUrl, frontendModel, ...extra] = process.argv.slice(2);
const token = process.env.GHCP_BRIDGE_TOKEN;
if (!outputPath || !baseUrl || !frontendModel || extra.length || !token?.trim()) {
  console.error(
    "Usage: GHCP_BRIDGE_TOKEN=... node src/write-launch-settings.mjs <output> <base-url> <frontend-model>",
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
  // Same ids launchModelFor gives these models, `[1m]` included, so a family
  // launch still matches its row and the alias carries the 1M window.
  familyModels: {
    opus: launchModelFor("claude-opus-5.5"),
    sonnet: launchModelFor("claude-sonnet-5"),
    haiku: launchModelFor("claude-haiku-4.5"),
  },
  displayNames: {
    opus: "GitHub Copilot Claude Opus 5.5",
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

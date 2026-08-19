import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function hostFromUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export function detectProvider(settingsPath = path.join(os.homedir(), ".claude", "settings.json")) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const env = settings.env || {};
  const host = hostFromUrl(env.ANTHROPIC_BASE_URL);
  const provider =
    host?.endsWith(".azuredatabricks.net") ? "azure-databricks" :
    host ? "custom-anthropic-compatible" :
    "default-or-managed";

  return {
    settingsPath,
    provider,
    baseUrlHost: host,
    model: settings.model || null,
    modelAliases: {
      fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || null,
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null,
      custom: env.ANTHROPIC_CUSTOM_MODEL_OPTION || null,
    },
    authConfigured: Boolean(
      env.ANTHROPIC_AUTH_TOKEN ||
      env.ANTHROPIC_API_KEY ||
      settings.apiKeyHelper
    ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const detected = detectProvider(process.argv[2]);
  console.log(JSON.stringify(detected, null, 2));
}

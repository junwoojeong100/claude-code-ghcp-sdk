import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectProvider } from "../src/provider-detection.mjs";

test("detects Azure Databricks without returning credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-test-"));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model: "opus",
      env: {
        ANTHROPIC_BASE_URL: "https://workspace.azuredatabricks.net/serving-endpoints",
        ANTHROPIC_AUTH_TOKEN: "secret",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "databricks-claude-opus",
      },
    }),
  );

  const detected = detectProvider(settingsPath);
  assert.equal(detected.provider, "azure-databricks");
  assert.equal(detected.baseUrlHost, "workspace.azuredatabricks.net");
  assert.equal(detected.authConfigured, true);
  assert.equal(JSON.stringify(detected).includes("secret"), false);

  fs.rmSync(directory, { recursive: true });
});

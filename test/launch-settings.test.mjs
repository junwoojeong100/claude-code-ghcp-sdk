import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_PROVIDER_SELECTORS } from "../src/claude-gateway-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeSettings(model) {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-settings-"));
  const settingsPath = path.join(fixtureDir, "settings.json");
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "src", "write-launch-settings.mjs"),
      settingsPath,
      "http://127.0.0.1:4142",
      "test-token",
      model,
    ],
    { encoding: "utf8" },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("sets the GPT 5.6 Copilot context window", () => {
  for (const variant of ["sol", "terra", "luna"]) {
    const model = `gpt-5.6-${variant}`;
    const settings = writeSettings(model);
    assert.equal(settings.env.ANTHROPIC_MODEL, model);
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1050000");
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.equal(
      settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      undefined,
    );
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, model);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    for (const name of CLAUDE_PROVIDER_SELECTORS) {
      assert.equal(settings.env[name], "");
    }
    assert.equal(settings.env.ENABLE_TOOL_SEARCH, "");
  }
});

test("does not override context limits for recognized Claude models", () => {
  const settings = writeSettings("claude-sonnet-5");
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
    "GitHub Copilot Claude Opus 5",
  );
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,
    "GitHub Copilot Claude Sonnet 5",
  );
  assert.equal(
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME,
    "GitHub Copilot Claude Haiku 4.5",
  );
});

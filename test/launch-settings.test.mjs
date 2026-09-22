import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_INHERITED_MODEL_OPTIONS,
  CLAUDE_PROVIDER_SELECTORS,
} from "../src/claude-gateway-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeSettings(model, env = {}) {
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
    { encoding: "utf8", env: { ...process.env, GHCP_NATIVE_TOOL_SEARCH: "0", ...env } },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test("uses model-scoped GPT 5.6 context hints and clears global context overrides", () => {
  for (const variant of ["sol", "terra", "luna"]) {
    const model = `gpt-5.6-${variant}`;
    const settings = writeSettings(model);
    assert.equal(settings.env.ANTHROPIC_MODEL, `github-copilot/claude-${model}[1m]`);
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.equal(
      settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      undefined,
    );
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, `github-copilot/claude-${model}[1m]`);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "");
    for (const name of CLAUDE_PROVIDER_SELECTORS) {
      assert.equal(settings.env[name], "");
    }
    assert.equal(settings.env.ENABLE_TOOL_SEARCH, "");
  }
});

test("uses the same per-model Astra context for launch and picker IDs", () => {
  for (const model of [
    "gpt-6-astra",
    "github-copilot/claude-gpt-6-astra[1m]",
  ]) {
    const settings = writeSettings(model);
    assert.equal(settings.env.ANTHROPIC_MODEL, "github-copilot/claude-gpt-6-astra[1m]");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "github-copilot/claude-gpt-6-astra[1m]");
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  }
});

test("clears inherited context overrides without replacing recognized Claude limits", () => {
  const settings = writeSettings("claude-sonnet-5", { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1178000" });
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "");
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "");
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

test("temporary Direct settings curate exactly seven picker options without a routing allowlist", () => {
  const settings = writeSettings("gpt-6-astra");
  assert.equal(settings.modelPicker.replaceBuiltInOptions, true);
  assert.equal(settings.modelPicker.options.length, 7);
  assert.deepEqual(settings.modelPicker.options.map((option) => option.model), [
    "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5",
    "github-copilot/claude-gpt-5.6-sol[1m]",
    "github-copilot/claude-gpt-5.6-terra[1m]",
    "github-copilot/claude-gpt-5.6-luna[1m]",
    "github-copilot/claude-gpt-6-astra[1m]",
  ]);
  assert.equal(settings.availableModels, undefined);
});

test("enables native Claude ToolSearch only with explicit GHCP opt-in", () => {
  assert.equal(writeSettings("claude-sonnet-5").env.ENABLE_TOOL_SEARCH, "");
  assert.equal(writeSettings("claude-sonnet-5", { GHCP_NATIVE_TOOL_SEARCH: "1" }).env.ENABLE_TOOL_SEARCH, "true");
  assert.throws(() => writeSettings("claude-sonnet-5", { GHCP_NATIVE_TOOL_SEARCH: "typo" }),
    /GHCP_NATIVE_TOOL_SEARCH must be 0 or 1/);
});

test("blanks inherited model options from user settings", () => {
  for (const model of ["claude-sonnet-5", "gpt-6-astra"]) {
    const settings = writeSettings(model);
    for (const name of CLAUDE_INHERITED_MODEL_OPTIONS) {
      assert.equal(settings.env[name], "");
    }
  }

  const familySettings = writeSettings("claude-sonnet-5");
  assert.equal(familySettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, "");
  assert.equal(
    familySettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
    "",
  );
});

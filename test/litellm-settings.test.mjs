import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("writes isolated LiteLLM settings with family aliases", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-litellm-settings-"));
  const settingsPath = path.join(fixtureDir, "settings.json");

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(rootDir, "src", "write-litellm-settings.mjs"),
        settingsPath,
        "https://litellm.example.com/",
        "corp-default",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LITELLM_API_KEY: "sk-test-only",
          LITELLM_OPUS_MODEL: "corp-opus",
          LITELLM_SONNET_MODEL: "corp-sonnet",
          LITELLM_HAIKU_MODEL: "corp-haiku",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://litellm.example.com");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-test-only");
    assert.equal(settings.env.ANTHROPIC_MODEL, "corp-default");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "corp-opus");
    assert.equal(
      settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
      "LiteLLM · corp-opus",
    );
    assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "corp-sonnet");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "corp-haiku");
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "corp-default");
    assert.equal(
      settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
      "LiteLLM · corp-default",
    );
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("rejects non-HTTP LiteLLM base URLs", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "src", "write-litellm-settings.mjs"),
      "/tmp/unused-litellm-settings.json",
      "file:///tmp/proxy",
      "corp-default",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LITELLM_API_KEY: "sk-test-only" },
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid LiteLLM base URL/);
});

test("rejects LiteLLM base URLs ending in v1", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDir, "src", "write-litellm-settings.mjs"),
      "/tmp/unused-litellm-settings.json",
      "https://litellm.example.com/v1",
      "corp-default",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LITELLM_API_KEY: "sk-test-only" },
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not end in \/v1/);
});

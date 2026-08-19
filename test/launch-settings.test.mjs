import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const settings = writeSettings(model);
    assert.equal(settings.env.ANTHROPIC_MODEL, model);
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1050000");
  }
});

test("does not override context limits for recognized Claude models", () => {
  const settings = writeSettings("claude-sonnet-4-6");
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

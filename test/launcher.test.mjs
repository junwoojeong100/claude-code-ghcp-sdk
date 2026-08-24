import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("claude command exposes the GHCP launcher", () => {
  const result = spawnSync(path.join(rootDir, "bin", "claude"), ["--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: claude-ghcp /);
  assert.match(result.stdout, /default: claude-sonnet-5/);
});

test("claude-ghcp rejects arguments that can bypass bridge routing", () => {
  const cases = [
    ["--settings", "/tmp/other-settings.json"],
    ["--", "--settings", "/tmp/other-settings.json"],
    ["--", "--model", "claude-sonnet-5"],
  ];

  for (const args of cases) {
    const result = spawnSync(path.join(rootDir, "bin", "claude-ghcp"), args, {
      encoding: "utf8",
    });

    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
  }
});

test("claude-litellm exposes a separate gateway launcher", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    ["--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: claude-litellm /);
  assert.match(result.stdout, /default: claude-sonnet-5/);
});

test("claude-litellm passes temporary gateway settings to upstream Claude", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-litellm-launcher-"));
  const fakeClaude = path.join(fixtureDir, "claude");
  const capturedSettings = path.join(fixtureDir, "captured-settings.json");
  const capturedSettingsPath = path.join(fixtureDir, "settings-path.txt");
  const userSettingsDir = path.join(fixtureDir, ".claude");
  const userSettingsPath = path.join(userSettingsDir, "settings.json");
  const userSettings = '{"env":{"EXISTING_PROVIDER":"unchanged"}}\n';
  mkdirSync(userSettingsDir);
  writeFileSync(userSettingsPath, userSettings);
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "while (($#)); do",
      '  if [[ "$1" == "--settings" ]]; then',
      '    cp "$2" "$CAPTURE_PATH"',
      '    printf "%s" "$2" > "$CAPTURE_SETTINGS_PATH"',
      "  fi",
      "  shift",
      "done",
      'printf "upstream-ok no-flicker=%s\\n" "${CLAUDE_CODE_NO_FLICKER:-}"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);

  try {
    const result = spawnSync(
      path.join(rootDir, "bin", "claude-litellm"),
      [],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CAPTURE_PATH: capturedSettings,
          CAPTURE_SETTINGS_PATH: capturedSettingsPath,
          CLAUDE_CODE_BIN: "",
          HOME: fixtureDir,
          LITELLM_API_KEY: "sk-test-only",
          LITELLM_BASE_URL: "https://litellm.example.com",
          LITELLM_MODEL: "",
          PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "upstream-ok no-flicker=1\n");
    const settings = JSON.parse(readFileSync(capturedSettings, "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://litellm.example.com");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-test-only");
    assert.equal(settings.env.ANTHROPIC_MODEL, "claude-sonnet-5");
    assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    const temporarySettingsPath = readFileSync(capturedSettingsPath, "utf8");
    assert.equal(existsSync(temporarySettingsPath), false);
    assert.equal(readFileSync(userSettingsPath, "utf8"), userSettings);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("claude-litellm rejects a wrapper as CLAUDE_CODE_BIN", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    [],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CODE_BIN: path.join(rootDir, "bin", "claude-litellm"),
        LITELLM_API_KEY: "sk-test-only",
        LITELLM_BASE_URL: "https://litellm.example.com",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must point to the real Claude Code executable/);
});

test("claude-litellm rejects settings passed after the separator", () => {
  const result = spawnSync(
    path.join(rootDir, "bin", "claude-litellm"),
    ["--", "--settings", "/tmp/other-settings.json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LITELLM_API_KEY: "sk-test-only",
        LITELLM_BASE_URL: "https://litellm.example.com",
      },
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Do not pass --model or --settings/);
});

test("claude-current skips the repository wrapper", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-ghcp-launcher-"));
  const fakeClaude = path.join(fixtureDir, "claude");
  writeFileSync(fakeClaude, "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\"\n");
  chmodSync(fakeClaude, 0o755);

  try {
    const result = spawnSync(
      path.join(rootDir, "bin", "claude-current"),
      ["--version"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CODE_BIN: "",
          PATH: `${path.join(rootDir, "bin")}:${fixtureDir}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "upstream:--version\n");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

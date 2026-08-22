import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { settingsFileState } from "../src/settings-file-state.mjs";

test("tracks missing and present settings files without requiring the file", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "claude-settings-state-"));
  const settingsPath = path.join(fixtureDir, "settings.json");

  try {
    assert.equal(settingsFileState(settingsPath), "missing");

    writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const initialState = settingsFileState(settingsPath);
    assert.match(initialState, /^present:[0-9a-f]{64}$/);
    assert.equal(settingsFileState(settingsPath), initialState);

    writeFileSync(settingsPath, '{"theme":"light"}\n');
    assert.notEqual(settingsFileState(settingsPath), initialState);

    rmSync(settingsPath);
    assert.equal(settingsFileState(settingsPath), "missing");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

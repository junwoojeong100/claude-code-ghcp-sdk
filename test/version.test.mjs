import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVersion,
  supportedNodeVersion,
  versionAtLeast,
} from "../src/version.mjs";

test("parses Claude Code version output", () => {
  assert.deepEqual(parseVersion("2.1.235 (Claude Code)"), [2, 1, 235]);
  assert.deepEqual(parseVersion("v22.16.0"), [22, 16, 0]);
  assert.equal(parseVersion("unknown"), null);
});

test("checks the Ultracode minimum Claude Code version", () => {
  assert.equal(versionAtLeast("2.1.235 (Claude Code)", "2.1.203"), true);
  assert.equal(versionAtLeast("2.1.202 (Claude Code)", "2.1.203"), false);
  assert.equal(versionAtLeast("unknown", "2.1.203"), null);
});

test("checks the Copilot SDK Node.js version range", () => {
  assert.equal(supportedNodeVersion("v20.18.1"), false);
  assert.equal(supportedNodeVersion("v20.19.0"), true);
  assert.equal(supportedNodeVersion("v21.7.3"), false);
  assert.equal(supportedNodeVersion("v22.11.0"), false);
  assert.equal(supportedNodeVersion("v22.12.0"), true);
  assert.equal(supportedNodeVersion("v24.0.0"), true);
  assert.equal(supportedNodeVersion("unknown"), null);
});

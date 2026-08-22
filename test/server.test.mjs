import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "server.mjs");

function runServerWith(overrides) {
  return spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRIDGE_API_KEY: "test-only",
      MAX_BODY_BYTES: "",
      PORT: "",
      ...overrides,
    },
  });
}

test("rejects invalid numeric bridge settings before startup", () => {
  const invalidPort = runServerWith({ PORT: "not-a-port" });
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /PORT must be a positive integer/);

  const outOfRangePort = runServerWith({ PORT: "65536" });
  assert.equal(outOfRangePort.status, 1);
  assert.match(outOfRangePort.stderr, /PORT must be between 1 and 65535/);

  const invalidBodyLimit = runServerWith({ MAX_BODY_BYTES: "0" });
  assert.equal(invalidBodyLimit.status, 1);
  assert.match(
    invalidBodyLimit.stderr,
    /MAX_BODY_BYTES must be a positive integer/,
  );
});

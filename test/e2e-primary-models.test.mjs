import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("primary E2E targets exactly the current seven-model validation set", () => {
  const script = readFileSync(
    new URL("../scripts/e2e-primary-models.sh", import.meta.url),
    "utf8",
  );
  const loop = script.match(/^for model in \\\n([\s\S]*?)^do$/m);
  assert.ok(loop, "Expected an explicit primary E2E target list");
  const models = loop[1].replaceAll("\\\n", "\n").trim().split(/\s+/);

  assert.deepEqual(models, [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
  ]);
});

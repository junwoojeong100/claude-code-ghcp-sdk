import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCopilotHome } from "../src/copilot-home.mjs";

test("resolves the default and home-relative Copilot directories", () => {
  assert.equal(
    resolveCopilotHome(),
    path.join(os.homedir(), ".copilot"),
  );
  assert.equal(resolveCopilotHome("~"), os.homedir());
  assert.equal(
    resolveCopilotHome("~/.copilot-work"),
    path.join(os.homedir(), ".copilot-work"),
  );
});

test("resolves relative Copilot directories from the working directory", () => {
  assert.equal(resolveCopilotHome(".copilot-work"), path.resolve(".copilot-work"));
});

import { spawnSync } from "node:child_process";

import { detectProvider } from "./provider-detection.mjs";

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    version: result.status === 0 ? result.stdout.trim() || result.stderr.trim() : null,
  };
}

const report = {
  node: commandVersion("node"),
  npm: commandVersion("npm"),
  claude: commandVersion(process.env.CLAUDE_CODE_BIN || "claude"),
  copilot: commandVersion("copilot"),
  currentProvider: null,
};

try {
  report.currentProvider = detectProvider();
} catch (error) {
  report.currentProvider = { error: error.message };
}

console.log(JSON.stringify(report, null, 2));
if (![report.node, report.npm, report.claude, report.copilot].every((item) => item.ok)) {
  process.exitCode = 1;
}

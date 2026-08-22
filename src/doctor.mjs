import { spawnSync } from "node:child_process";

import { detectProvider } from "./provider-detection.mjs";
import { supportedNodeVersion, versionAtLeast } from "./version.mjs";

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
report.compatibility = {
  node: {
    required: "^20.19.0 || >=22.12.0",
    supported: report.node.ok
      ? supportedNodeVersion(report.node.version)
      : false,
  },
  ultracode: {
    minimumClaudeCode: "2.1.203",
    supported: report.claude.ok
      ? versionAtLeast(report.claude.version, "2.1.203")
      : false,
  },
};

console.log(JSON.stringify(report, null, 2));
if (
  ![report.node, report.npm, report.claude, report.copilot].every((item) => item.ok) ||
  !report.compatibility.node.supported
) {
  process.exitCode = 1;
}

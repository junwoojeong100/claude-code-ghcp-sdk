import os from "node:os";
import path from "node:path";

export function resolveCopilotHome(value) {
  if (!value) return path.join(os.homedir(), ".copilot");
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

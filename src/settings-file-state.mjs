import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function settingsFileState(settingsPath) {
  try {
    const contents = readFileSync(settingsPath);
    const hash = createHash("sha256").update(contents).digest("hex");
    return `present:${hash}`;
  } catch (error) {
    if (error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) {
    console.error("Usage: settings-file-state.mjs PATH");
    process.exitCode = 2;
  } else {
    console.log(settingsFileState(process.argv[2]));
  }
}

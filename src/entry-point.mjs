import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function realPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

// Whether the module at moduleUrl is the script node was started with. Node
// resolves symlinks in the main module's path before loading it, so
// import.meta.url names the real file while process.argv[1] keeps the path the
// caller typed. Compared as-is, the two never match through a symlinked
// directory -- /tmp is one on macOS -- and the module silently skips its CLI:
// `node /tmp/<checkout>/src/bridge-daemon.mjs ensure` exited 0 with no output.
// Comparing real paths also covers --preserve-symlinks-main, which keeps the
// symlink in import.meta.url instead, and paths that URL-encoding would change.
export function isEntryPoint(moduleUrl, scriptPath = process.argv[1]) {
  if (!scriptPath) return false;
  return realPath(scriptPath) === realPath(fileURLToPath(moduleUrl));
}

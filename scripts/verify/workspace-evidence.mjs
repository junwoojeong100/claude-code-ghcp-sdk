/** Save small synthetic workspaces before sealing, without following links. */
import fs from "node:fs";
import path from "node:path";
import { digest } from "./fixtures.mjs";

export function preserveWorkspace(workspace, target, { maxBytes = 8 * 1024 * 1024, maxEntries = 128 } = {}) {
  const entries = [];
  let bytes = 0;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128) throw new Error("Invalid workspace evidence limits");
    for (const root of [workspace, path.dirname(target)]) {
      if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== path.resolve(root)) throw new Error("Workspace evidence requires real directories");
    }
    const visit = relative => {
      if (entries.length >= maxEntries) throw new Error("Workspace evidence entry limit");
      const file = path.join(workspace, relative), stat = fs.lstatSync(file);
      const entry = { path: relative, mode: stat.mode & 0o777 };
      if (stat.isSymbolicLink()) {
        entry.kind = "symlink"; entry.target = fs.readlinkSync(file);
        bytes += Buffer.byteLength(entry.target);
      } else if (stat.isDirectory()) entry.kind = "directory";
      else if (stat.isFile()) {
        if (stat.size > maxBytes - bytes) throw new Error("Workspace evidence byte limit");
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error("Workspace changed during capture");
          const content = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < content.length) {
            const read = fs.readSync(fd, content, offset, content.length - offset, offset);
            if (!read) throw new Error("Workspace changed during capture");
            offset += read;
          }
          const after = fs.fstatSync(fd);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Workspace changed during capture");
          entry.kind = "file"; entry.bytes = content.length; entry.sha256 = digest(content); entry.base64 = content.toString("base64");
          bytes += content.length;
        } finally { fs.closeSync(fd); }
      } else throw new Error("Unsupported workspace entry");
      if (bytes > maxBytes) throw new Error("Workspace evidence byte limit");
      entries.push(entry);
      if (entry.kind === "directory") for (const name of fs.readdirSync(file).sort()) visit(relative ? `${relative}/${name}` : name);
    };
    visit("");
    const content = JSON.stringify({ schemaVersion: 1, entries }) + "\n";
    fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    return { ok: true, file: path.basename(target), sha256: digest(content), entries: entries.length, bytes };
  } catch (error) { return { ok: false, reason: error.message }; }
}

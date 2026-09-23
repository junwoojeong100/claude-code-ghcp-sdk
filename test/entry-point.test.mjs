import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isEntryPoint } from "../src/entry-point.mjs";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function linkedTree(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ghcp-entry-")));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const real = path.join(directory, "real");
  mkdirSync(real);
  const script = path.join(real, "cli.mjs");
  writeFileSync(script, "");
  const link = path.join(directory, "link");
  symlinkSync(real, link);
  return { script, linked: path.join(link, "cli.mjs") };
}

test("recognises the script through a symlinked directory", (t) => {
  const { script, linked } = linkedTree(t);
  const moduleUrl = pathToFileURL(script).href;

  assert.equal(isEntryPoint(moduleUrl, script), true);
  // What node reports after resolving the main module's symlinks.
  assert.equal(isEntryPoint(moduleUrl, linked), true);
  // What --preserve-symlinks-main reports instead.
  assert.equal(isEntryPoint(pathToFileURL(linked).href, script), true);
});

test("an imported module is not the entry point", (t) => {
  const { script } = linkedTree(t);
  const moduleUrl = pathToFileURL(script).href;

  assert.equal(isEntryPoint(moduleUrl, path.join(path.dirname(script), "other.mjs")), false);
  // The REPL and `node -e` leave argv[1] unset.
  assert.equal(isEntryPoint(moduleUrl, undefined), false);
  assert.equal(isEntryPoint(moduleUrl, ""), false);
});

test("a CLI module still runs when started through a symlinked checkout", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ghcp-entry-cli-")));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const link = path.join(directory, "src");
  symlinkSync(srcDir, link);

  // `node /tmp/<checkout>/src/bridge-daemon.mjs ensure` used to exit 0 with
  // no output here, and bin/claude-ghcp then failed to parse the empty reply.
  const result = spawnSync(
    process.execPath,
    [path.join(link, "settings-file-state.mjs"), path.join(directory, "absent.json")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "missing");
});

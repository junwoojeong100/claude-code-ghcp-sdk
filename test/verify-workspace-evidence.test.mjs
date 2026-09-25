/** Synthetic fixture retention, not an archive of old verification results. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preserveWorkspace } from "../scripts/verify/workspace-evidence.mjs";
import { digest } from "../scripts/verify/fixtures.mjs";

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-workspace-evidence-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), target = path.join(root, "workspace.json");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "sample.txt"), "안녕 café\n", { mode: 0o600 });
  return { root, workspace, target };
}

test("workspace copy retains bytes and modes and records links without following them", t => {
  const { workspace, target } = setup(t);
  fs.mkdirSync(path.join(workspace, "empty"));
  fs.symlinkSync("/absent/private/target", path.join(workspace, "link"));
  const result = preserveWorkspace(workspace, target);
  assert.equal(result.ok, true, result.reason);
  const raw = fs.readFileSync(target), saved = JSON.parse(raw);
  assert.equal(digest(raw), result.sha256);
  assert.equal(saved.schemaVersion, 1);
  const file = saved.entries.find(e => e.path === "sample.txt");
  assert.equal(Buffer.from(file.base64, "base64").toString(), "안녕 café\n");
  assert.equal(file.sha256, digest(Buffer.from(file.base64, "base64")));
  assert.equal(file.mode, 0o600);
  const link = saved.entries.find(e => e.path === "link");
  assert.equal(link.kind, "symlink"); assert.equal(link.target, "/absent/private/target");
  assert.equal(saved.entries.some(e => e.path.startsWith("link/")), false);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

for (const limits of [{ maxBytes: 1 }, { maxEntries: 1 }, { maxBytes: Infinity }, { maxEntries: -1 }]) {
  test(`workspace capture rejects bounded limit violation ${JSON.stringify(limits)}`, t => {
    const { workspace, target } = setup(t);
    assert.equal(preserveWorkspace(workspace, target, limits).ok, false);
    assert.equal(fs.existsSync(target), false);
  });
}

test("workspace capture never replaces existing evidence or follows root/parent links", t => {
  const { root, workspace, target } = setup(t);
  fs.writeFileSync(target, "original");
  assert.equal(preserveWorkspace(workspace, target).ok, false);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  fs.symlinkSync(workspace, path.join(root, "linked-workspace"));
  assert.equal(preserveWorkspace(path.join(root, "linked-workspace"), path.join(root, "no.json")).ok, false);
  fs.symlinkSync(root, path.join(root, "linked-parent"));
  assert.equal(preserveWorkspace(workspace, path.join(root, "linked-parent", "no.json")).ok, false);
  assert.equal(fs.existsSync(path.join(root, "no.json")), false);
});

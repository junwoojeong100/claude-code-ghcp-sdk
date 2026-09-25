/** Structural contract only; no model, SDK client or network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRIMARY_MODELS, SCENARIOS, SCENARIO_IDS, SUITE_ID, SCHEMA_VERSION, gateFor, switchSource } from "../scripts/verify/scenarios.mjs";
import { DRIVERS } from "../scripts/verify/drivers.mjs";
import { FIXTURE_IDS, buildFixture } from "../scripts/verify/fixtures.mjs";
import { createRunDefinition } from "../scripts/verify/summary.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("six bilingual essential scenarios retain six exact primary models", () => {
  assert.equal(SUITE_ID, "claude-ghcp-essential-v1"); assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(SCENARIO_IDS, ["V01", "V02", "V03", "V04", "V05", "V06"]);
  assert.deepEqual(PRIMARY_MODELS, ["claude-opus-5.5", "claude-sonnet-5", "claude-haiku-4.5", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
  for (const s of SCENARIOS) {
    assert.equal(s.revision, ["V01", "V05", "V06"].includes(s.id) ? 2 : 1);
    assert.ok(s.budgetSeconds > 0 && s.name && s.nameKo);
    assert.equal(s.pass.length, s.passKo.length); assert.ok(s.pass.length);
    assert.ok(s.phases.length && new Set(s.phases.map(p => p.id)).size === s.phases.length);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.phases));
  }
  assert.equal(switchSource("gpt-6-astra"), "gpt-6-luna");
  assert.equal(switchSource("claude-sonnet-5"), "gpt-6-astra");
});

test("drivers and fixtures match the exact 36-slot product", () => {
  assert.deepEqual(Object.keys(DRIVERS), SCENARIO_IDS); assert.deepEqual(FIXTURE_IDS, SCENARIO_IDS);
  const run = createRunDefinition(PRIMARY_MODELS, SCENARIOS);
  assert.equal(run.expectedTotal, 36); assert.equal(run.scope.kind, "full");
  assert.equal(new Set(run.expectedSlots.map(s => JSON.stringify(s))).size, 36);
  assert.equal(gateFor(run.expectedTotal), 36);
  assert.equal(createRunDefinition(PRIMARY_MODELS, SCENARIOS.slice(0, 1)).scope.kind, "focused");
});

test("only V02 has code and hidden sample fixtures", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-essential-fixtures-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of SCENARIO_IDS) {
    const dir = path.join(root, id), fixture = buildFixture(id, dir);
    assert.equal(fixture.id, id);
    assert.deepEqual(fs.readdirSync(dir).sort(), id === "V02" ? ["discount.mjs", "discount.test.mjs", "sample.txt", "user-notes.txt"] : ["user-notes.txt"]);
    if (id === "V02") { assert.equal(fixture.testNames.length, 3); assert.equal(fixture.initialFailures.length, 2); }
    assert.throws(() => buildFixture(id, dir), /empty workspace/);
  }
  assert.throws(() => buildFixture("core-coding-resume", path.join(root, "old")), /No fixture/);
  assert.equal(fs.existsSync(path.join(root, "old")), false);
});

test("npm keeps one plan/run/report path and no legacy verifier modules", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
  assert.equal(scripts["verify:plan"], "node scripts/verify/run.mjs --dry-run");
  assert.equal(scripts["verify:doc"], "node scripts/verify/report.mjs --write-docs");
  assert.equal(scripts["verify:report"], "node scripts/verify/report.mjs");
  assert.equal(scripts["verify:probe"], undefined);
  for (const file of ["features.mjs", "probe.mjs", "media.mjs", "tui.mjs", "terminal-pty.py", "native-dialog.mjs"]) assert.equal(fs.existsSync(path.join(ROOT, "scripts/verify", file)), false);
  assert.equal(fs.existsSync(path.join(ROOT, "test/fixtures/mcp-echo-server.mjs")), false);
});

// Every run fingerprints and freezes these files, so an unused one changes provenance for nothing.
const ENTRY_POINTS = new Set(["recording.mjs", "render-recording.mjs"]);
test("every verifier module and test fixture has a consumer or is a declared entry point", () => {
  const files = dir => fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => path.relative(ROOT, path.join(e.parentPath ?? e.path, e.name)));
  const corpus = [...["src", "scripts", "bin", "test"].flatMap(files), "package.json"]
    .filter(f => f !== "test/verify-suite.test.mjs" && !/\.(?:log|jsonl|md)$/.test(f))
    .map(f => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]);
  const consumers = (file, dirs) => {
    const name = path.basename(file), mention = new RegExp(`(?:^|[/"'\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|["'\\s\`)])`, "m");
    return corpus.filter(([f, text]) => f !== file && dirs.some(d => f === d || f.startsWith(`${d}/`)) && mention.test(text)).map(([f]) => f);
  };
  const orphans = [
    ...files("scripts/verify").filter(f => /\.(?:mjs|py)$/.test(f) && !ENTRY_POINTS.has(path.basename(f)) && !consumers(f, ["src", "scripts", "bin", "package.json"]).length),
    ...files("test/fixtures").filter(f => !consumers(f, ["src", "scripts", "bin", "test", "package.json"]).length),
  ];
  assert.deepEqual(orphans, []);
  assert.ok(consumers("scripts/verify/mcp-fixture.mjs", ["scripts"]).includes("scripts/verify/drivers.mjs"));
  assert.ok(consumers("scripts/verify/native-dialogs.mjs", ["scripts"]).includes("scripts/verify/interactive.mjs"));
});

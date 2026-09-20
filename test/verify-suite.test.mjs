/**
 * Structural guards for the verification suite.
 *
 * These do not call a model. They protect the properties that make the suite's
 * claims meaningful: that the catalogue is the size it says it is, that the
 * coverage number clears the bar it advertises, that every scenario has a
 * driver and a fixture, and that no scenario claims a feature whose tool this
 * build does not offer.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ABSENT_TOOLS, COVERAGE_TARGET, FEATURES, coverage } from "../scripts/verify/features.mjs";
import { PRIMARY_MODELS, SCENARIOS, gateFor, planRun, validateCatalog } from "../scripts/verify/scenarios.mjs";
import { DRIVERS } from "../scripts/verify/drivers.mjs";
import { FIXTURE_IDS, buildFixture } from "../scripts/verify/fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the catalogue validates", () => {
  const { ok, problems } = validateCatalog();
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.equal(ok, true);
});

test("ten scenarios, seven models", () => {
  assert.equal(SCENARIOS.length, 10);
  assert.equal(PRIMARY_MODELS.length, 7);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 10);
  assert.equal(new Set(PRIMARY_MODELS).size, 7);
});

test("coverage clears the advertised bar", () => {
  const result = coverage(SCENARIOS);
  assert.deepEqual(result.unknown, [], `unknown feature ids: ${result.unknown.join(", ")}`);
  assert.ok(
    result.ratio >= COVERAGE_TARGET,
    `coverage ${result.percent}% is below the ${COVERAGE_TARGET * 100}% target`,
  );
});

test("no scenario claims a feature this build cannot offer", () => {
  const result = coverage(SCENARIOS);
  assert.deepEqual(
    result.claimedButAbsent,
    [],
    `scenarios claim features gated on absent tools: ${result.claimedButAbsent.join(", ")}`,
  );
});

test("absent tools are named, not implied", () => {
  // If this list is emptied without re-measuring, the coverage denominator
  // silently grows and the reported percentage drops for no stated reason.
  assert.ok(ABSENT_TOOLS.length > 0);
  for (const tool of ABSENT_TOOLS) assert.match(tool, /^[A-Z][A-Za-z]+$/);
});

test("every scenario has a driver and a fixture", () => {
  for (const scenario of SCENARIOS) {
    assert.equal(typeof DRIVERS[scenario.id], "function", `no driver for ${scenario.id}`);
    assert.ok(FIXTURE_IDS.includes(scenario.id), `no fixture for ${scenario.id}`);
  }
  assert.equal(Object.keys(DRIVERS).length, SCENARIOS.length);
  assert.equal(FIXTURE_IDS.length, SCENARIOS.length);
});

test("every fixture builds", (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT, ".verify-fixture-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const scenario of SCENARIOS) {
    const workspace = path.join(dir, scenario.id);
    const fixture = buildFixture(scenario.id, workspace, { token: "TESTTK" });
    assert.equal(fixture.dir, workspace);
    assert.ok(fs.existsSync(workspace), `${scenario.id} produced no workspace`);
  }
});

test("every fixture workspace is its own git toplevel", (t) => {
  // Deliberately built inside this checkout, exactly where slots live. A
  // workspace that is not its own repository reports THIS repository as its
  // toplevel, and a model asked for a repo-relative path writes into the
  // source tree. That has happened; this is the guard against it returning.
  const dir = fs.mkdtempSync(path.join(ROOT, ".verify-fixture-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outerToplevel = fs.realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" }).trim(),
  );
  for (const scenario of SCENARIOS) {
    const workspace = path.join(dir, scenario.id);
    buildFixture(scenario.id, workspace, { token: "TESTTK" });
    const toplevel = fs.realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8" }).trim(),
    );
    assert.equal(toplevel, fs.realpathSync(workspace), `${scenario.id} escapes to ${toplevel}`);
    assert.notEqual(toplevel, outerToplevel, `${scenario.id} resolves to the real repository`);
  }
});

test("every feature a scenario covers exists in the inventory", () => {
  const ids = new Set(FEATURES.map((f) => f.id));
  for (const scenario of SCENARIOS) {
    for (const id of scenario.covers) {
      assert.ok(ids.has(id), `${scenario.id} covers unknown feature ${id}`);
    }
  }
});

test("the gate is a real bar, not a formality", () => {
  assert.equal(gateFor(70), 67);
  assert.equal(gateFor(10), 10);
  assert.ok(gateFor(70) < 70, "a gate that equals the slot count leaves no headroom");
});

test("planRun accounts for every slot", () => {
  const plan = planRun();
  assert.equal(plan.slots, SCENARIOS.length * PRIMARY_MODELS.length);
  assert.ok(plan.wallClockSeconds > 0);
  assert.equal(plan.withinLimit, true, `plan exceeds the wall-clock limit: ${plan.wallClockSeconds}s`);
});

test("scenario budgets are stated and finite", () => {
  for (const scenario of SCENARIOS) {
    assert.ok(
      Number.isInteger(scenario.budgetSeconds) && scenario.budgetSeconds > 0,
      `${scenario.id} has no usable budget`,
    );
    assert.ok(scenario.pass.length > 0, `${scenario.id} states no pass criteria`);
    assert.ok(scenario.intentKo && scenario.bridgeRiskKo, `${scenario.id} is missing Korean copy`);
  }
});

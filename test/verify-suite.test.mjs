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
import { DRIVERS, mentions, mentionsToken } from "../scripts/verify/drivers.mjs";
import { FIXTURE_IDS, buildFixture } from "../scripts/verify/fixtures.mjs";
import { buildPng } from "../scripts/verify/media.mjs";
import { PROBES } from "../scripts/verify/probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the catalogue validates", () => {
  const { ok, problems } = validateCatalog();
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.equal(ok, true);
});

test("eleven scenarios, seven models", () => {
  assert.equal(SCENARIOS.length, 11);
  assert.equal(PRIMARY_MODELS.length, 7);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 11);
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

test("the two matchers forgive different separators, and say which", () => {
  // Two models made the identical mis-read of the same rasterised token. The
  // one that typed a space passed, the one that typed a hyphen failed -- the
  // separator decided the verdict, not the model. For a token the harness drew
  // into an image, all four have to collapse, which is mentionsToken's job.
  const needle = "IMGTAG351417";
  for (const separator of [" ", "-", "_", ",", ", ", " - ", "__"]) {
    const answer = `the image reads IMG${separator}TAG${separator}351417`;
    assert.ok(mentionsToken(answer, needle), `separator ${JSON.stringify(separator)} did not collapse`);
  }
  // Forgiving separators must not forgive a wrong token.
  assert.equal(mentionsToken("the image reads IMG-TAG-351418", needle), false);
  assert.equal(mentionsToken("the image reads PDFDOC-351417", needle), false);

  // mentions() stops one separator short, and that is the point: it reads
  // ordinary prose needles against the model's own sentences, where a hyphen
  // carries meaning. Space, comma and underscore still collapse.
  for (const separator of [" ", "_", ",", ", ", "__"]) {
    const answer = `the image reads IMG${separator}TAG${separator}351417`;
    assert.ok(mentions(answer, needle), `separator ${JSON.stringify(separator)} did not collapse`);
  }
  assert.equal(mentions("the image reads IMG-TAG-351417", needle), false);
});

test("mentions() does not read a cited line range as the constant", () => {
  // v01's "reports the constant's value" is the only check there that separates
  // reading the constant from waffling about the file, and its needle is two
  // digits (fixtures.mjs needleValue "37") in a scenario that invites models to
  // cite line ranges. Collapse the hyphen on the HAYSTACK side -- the model's
  // own prose -- and every one of these becomes a pass nobody earned.
  assert.equal(mentions("see lines 3-7 of settlement.mjs", "37"), false);
  assert.equal(mentions("RETRY_LIMIT spans 3 - 7", "37"), false);
  assert.equal(mentions("build 81-23", "8123"), false);
  assert.equal(mentions("deploys Thursday 02:00-UTC", "Thursday 02:00 UTC"), false);

  // The answers these checks exist to accept still pass.
  assert.ok(mentions("SPREAD_BPS = 37", "37"));
  assert.ok(mentions("build 8_123", "8123"));
  assert.ok(mentions("window: Thursday, 02:00 UTC", "Thursday 02:00 UTC"));

  // And the tolerance stays reachable exactly where it was earned.
  assert.ok(mentionsToken("the image reads IMGTAG-E51B5C", "IMGTAGE51B5C"));
  assert.equal(mentions("the image reads IMGTAG-E51B5C", "IMGTAGE51B5C"), false);
});

test("the v05 media tokens stay inside the block font's alphabet", (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT, ".verify-fixture-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fixture = buildFixture("v05-multi-step", path.join(dir, `ws-${attempt}`), { token: "TESTTK" });
    for (const token of [fixture.pdfToken, fixture.pngToken]) {
      // A-Z and 0-9 only. The font also draws "-", but a separator inside the
      // needle is what made the image check depend on how a model segmented
      // the glyphs rather than on whether it read them.
      assert.match(token, /^[A-Z0-9]+$/, `${token} is not separator-free block-font text`);
      assert.ok(token.length <= 13, `${token} is ${token.length} glyphs wide`);
      // buildPng silently skips any character it has no glyph for, so width
      // measures how much of the token actually reached the raster.
      const width = (text) => buildPng(text).readUInt32BE(16);
      assert.equal(width(token), width("A".repeat(token.length)), `${token} lost a glyph in the raster`);
      // The regex above already admits nothing glyphless, so on its own that
      // equality can never fire. Prove the yardstick against a token that is:
      // ":" has no glyph, gets dropped, and the render comes back a cell
      // narrower. Note this would NOT catch "-" -- media.mjs draws it -- which
      // is why the regex, not the width, is what keeps separators out.
      const glyphless = `${token.slice(0, 6)}:${token.slice(7)}`;
      assert.equal(glyphless.length, token.length);
      assert.ok(
        width(glyphless) < width("A".repeat(glyphless.length)),
        `${glyphless} rendered full width, so the width check is incapable of failing`,
      );
    }
  }
});

test("the v05 media tokens owe nothing to the run token", (t) => {
  // Step 3 of the v05 prompt prints the run token. A media token derived from
  // it is answerable from the prompt alone -- which is the one thing the two
  // attachment checks exist to rule out, and a model did exactly that.
  const dir = fs.mkdtempSync(path.join(ROOT, ".verify-fixture-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runToken = "ZQ7WMP";
  const seen = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fixture = buildFixture("v05-multi-step", path.join(dir, `ws-${attempt}`), { token: runToken });
    assert.equal(fixture.token, runToken);
    for (const token of [fixture.pdfToken, fixture.pngToken]) {
      assert.ok(!token.includes(runToken), `${token} embeds the run token`);
      seen.add(token);
    }
    // The old scheme derived the media tokens as `PDFDOC-${runToken}` and
    // `IMGTAG-${runToken}`, so an answer that only parroted step 3's run token
    // back satisfied both attachment checks with neither file opened. Measure
    // against the answer such a model writes, through the matcher the driver
    // actually calls. The old tokens are asserted to match it first, so the
    // control is demonstrated rather than taken on faith; the drawn tokens
    // must not.
    const parroted = `the PDF says PDFDOC-${runToken} and the image says IMGTAG-${runToken}`;
    assert.ok(
      mentionsToken(parroted, `PDFDOC-${runToken}`) && mentionsToken(parroted, `IMGTAG-${runToken}`),
      "the derived-token control no longer matches the answer it exists to model",
    );
    assert.equal(
      mentionsToken(parroted, fixture.pdfToken),
      false,
      `${fixture.pdfToken} is satisfiable from the prompt text alone`,
    );
    assert.equal(
      mentionsToken(parroted, fixture.pngToken),
      false,
      `${fixture.pngToken} is satisfiable from the prompt text alone`,
    );
  }
  // Constants would give exactly two distinct values across four builds.
  assert.ok(seen.size > 2, "media tokens are not redrawn per fixture");
});

/* ------------------------------------------------------------------ *
 * The probe path carries the same rasterised-token hazard as the slots
 * ------------------------------------------------------------------ */

// The judge only reads these four members off a run.
const stubRun = (answer) => ({ answer, completed: true, usedTool: () => true, toolResults: [] });

// How a model that read the raster correctly might segment the glyphs. The
// verdict has to turn on what it read, never on which of these it typed.
const SEGMENTATIONS = ["", " ", "-", "_", ", ", " - "];
const segment = (token, separator) => `${token.slice(0, 6)}${separator}${token.slice(6)}`;

test("the multimodal probe's tokens survive however a model segments the glyphs", (t) => {
  // probe.mjs rasterised "PDFTOKEN-QX47" and "IMG-K9T2" and matched them with a
  // bare includes. Measured against that judge: of four correct reads, only the
  // one that happened to type the fixture's own hyphen passed -- the same coin
  // flip already fixed on the slot path, still live here.
  const dir = fs.mkdtempSync(path.join(ROOT, ".verify-fixture-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const width = (text) => buildPng(text).readUInt32BE(16);
  const seen = new Set();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const workspace = path.join(dir, `probe-${attempt}`);
    fs.mkdirSync(workspace, { recursive: true });
    const fixture = PROBES.multimodal.fixture(workspace) ?? {};
    const judge = (answer) => PROBES.multimodal.judge(stubRun(answer), { workspace, fixture });

    for (const token of [fixture.pdfToken, fixture.pngToken]) {
      // A-Z and 0-9 only. media.mjs DRAWS "-" -- it rasterises at full cell
      // width -- so a render-width check is structurally incapable of catching
      // a hyphen here. The alphabet is the entire guard.
      assert.match(token, /^[A-Z0-9]+$/, `${token} is not separator-free block-font text`);
      assert.equal(width(token), width("A".repeat(token.length)), `${token} lost a glyph in the raster`);
      seen.add(token);
    }

    for (const separator of SEGMENTATIONS) {
      const answer = `${segment(fixture.pdfToken, separator)}\n${segment(fixture.pngToken, separator)}`;
      const verdict = judge(answer);
      assert.ok(
        verdict.pdfToken && verdict.pngToken,
        `separator ${JSON.stringify(separator)} sank a correct read: ${answer}`,
      );
    }

    // Forgiving the separator must not forgive a wrong token. Derived from the
    // drawn one so the control cannot collide with it by chance.
    const bump = (token) => token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    const wrong = judge(`${bump(fixture.pdfToken)}\n${bump(fixture.pngToken)}`);
    assert.equal(wrong.pdfToken, false, `${fixture.pdfToken} matched a token one character off`);
    assert.equal(wrong.pngToken, false, `${fixture.pngToken} matched a token one character off`);

    // Nor may one attachment's token satisfy the other's check: the two are
    // drawn independently, and that is what separates "read both files" from
    // "read one and repeated it".
    const pngOnly = judge(fixture.pngToken);
    assert.equal(pngOnly.pdfToken, false, "the PDF check is satisfiable from the image token alone");
    assert.equal(pngOnly.pngToken, true);
  }
  // Constants would give exactly two distinct values across four builds.
  assert.ok(seen.size > 2, "probe media tokens are not redrawn per fixture");
});

test("drivers.mjs wires the tolerant matcher to the media tokens and nothing else", () => {
  // The two regexes are pinned in isolation above; the WIRING was not pinned at
  // all. Measured in a clean sandbox: widening v01's "reports the constant's
  // value" from mentions( to mentionsToken( left the suite fully green, so
  // nothing failed. Stripping "-" from the HAYSTACK -- the model's own prose --
  // lets "lines 3-7" satisfy the needle "37".
  //
  // drivers.mjs is owned by another lane, so everything below anchors on code
  // shape. No line number, no ordering, no hardcoded call-site count.
  const source = fs.readFileSync(path.join(ROOT, "scripts/verify/drivers.mjs"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");

  const sites = [];
  const call = /\b(mentionsToken|mentions)\s*\(/g;
  let match;
  while ((match = call.exec(code)) !== null) {
    // The two definitions are not call sites.
    if (/\bfunction\s+$/.test(code.slice(0, match.index))) continue;

    // Balanced scan, so a nested call inside an argument cannot truncate it.
    let depth = 0;
    let end = -1;
    for (let i = match.index + match[0].length - 1; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")" && (depth -= 1) === 0) { end = i; break; }
    }
    assert.ok(end > 0, `unbalanced ${match[1]}( call site in drivers.mjs`);

    const args = code.slice(match.index + match[0].length, end);
    const parts = [];
    let nested = 0;
    let current = "";
    for (const ch of args) {
      if (ch === "(" || ch === "[" || ch === "{") nested += 1;
      else if (ch === ")" || ch === "]" || ch === "}") nested -= 1;
      if (ch === "," && nested === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    sites.push({ matcher: match[1], needle: (parts[1] ?? "").trim() });
  }

  const MEDIA = /\b(pdfToken|pngToken)\b/;
  const tolerant = sites.filter((s) => s.matcher === "mentionsToken");
  const strict = sites.filter((s) => s.matcher === "mentions");

  assert.ok(sites.length > 2, `found only ${sites.length} matcher call sites; the scan is not reaching them`);
  assert.ok(strict.length > 0, "every call site is tolerant: the split is no longer enforced anywhere");

  // Widening any non-media check lands here.
  for (const site of tolerant) {
    assert.match(
      site.needle,
      MEDIA,
      `mentionsToken(_, ${site.needle}) is not a media-token check -- stripping "-" from the haystack ` +
        `lets an answer of "lines 3-7" satisfy the needle "37"`,
    );
  }
  // Narrowing either media check lands here.
  for (const site of strict) {
    assert.doesNotMatch(
      site.needle,
      MEDIA,
      `mentions(_, ${site.needle}) routes a rasterised token through the strict matcher, which decides ` +
        `the verdict on how the model segmented the glyphs rather than on what it read`,
    );
  }

  // Both are actually wired -- "no violations found" must not pass by default.
  assert.deepEqual(
    [...new Set(tolerant.map((s) => s.needle.match(MEDIA)[1]))].sort(),
    ["pdfToken", "pngToken"],
    `the tolerant matcher reaches ${tolerant.length} call site(s): ${tolerant.map((s) => s.needle).join(", ")}`,
  );
});

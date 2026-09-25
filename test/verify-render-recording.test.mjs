import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { evaluateStoredSlot } from "../scripts/verify/drivers.mjs";
import { readRecording } from "../scripts/verify/recording.mjs";
import { PALETTE, captionFor, chromeRasterizer, createReplay, describeCuts, main, parseRenderArgs, parseSpec, phaseAt, phasesIn, planFrames,
  prepareOutputDir, redactSnapshot, redactText, redactionRules, renderMedia, renderScreenHTML, renderSummaryHTML, rowText } from "../scripts/verify/render-recording.mjs";
import { PRIMARY_MODELS, SCENARIOS } from "../scripts/verify/scenarios.mjs";
import { FINGERPRINT_SCOPE, createRunDefinition } from "../scripts/verify/summary.mjs";
import { makeSlot } from "./fixtures/verify-evidence.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const SLOT = "claude-opus-5.5__V01", SLOT2 = "gpt-6-luna__V06";
const rules = redactionRules({ home: "/Users/alice", username: "alice" });
function tmp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-render-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeRecording(file, events, { endMs = null, launch = "launch-1" } = {}) {
  let seq = 0, outputBytes = 0, last = 0;
  const lines = [{ type: "header", schema: "ghcp-terminal-output", version: 1, cols: 160, rows: 48, launch, session: "session-1", seq: 0, timeMs: 0 }];
  for (const e of events) {
    last = e.t;
    if (e.phase) lines.push({ type: "phase", seq: ++seq, timeMs: e.t, label: e.phase });
    else {
      const bytes = Buffer.isBuffer(e.out) ? e.out : Buffer.from(e.out);
      outputBytes += bytes.length;
      lines.push({ type: "output", seq: ++seq, timeMs: e.t, data: bytes.toString("base64") });
    }
  }
  lines.push({ type: "footer", seq: seq + 1, timeMs: endMs ?? last, complete: true, truncated: false, error: null, frames: seq, outputBytes });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  return file;
}
async function screen(t, events, atMs = Infinity) {
  const file = writeRecording(path.join(tmp(t), "r.jsonl"), events);
  const replay = createReplay(readRecording(file));
  t.after(() => replay.dispose());
  await replay.advance(Math.min(atMs, 1e9));
  return replay.snapshot();
}
const at = (snapshot, y, x) => snapshot.rows[y].cells[x];
function png(width, height, tag) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return Buffer.concat([b, Buffer.from(sha(tag))]);
}
function stubRasterizer() {
  const pages = [];
  return { pages, chrome: "stub-chrome", playwright: "stub-playwright", render: async html => { pages.push(html); return png(1377, 874, html); }, close: async () => {} };
}
function stubEncoder({ frames = null } = {}) {
  const calls = [];
  return { calls, version: "ffmpeg stub", probeVersion: "ffprobe stub", encoder: "libx264", codec: "h264",
    async encode({ framesDir, fps, out }) {
      const names = fs.readdirSync(framesDir).sort();
      calls.push({ names, fps });
      fs.writeFileSync(out, names.map(n => sha(fs.readFileSync(path.join(framesDir, n)))).join("\n"), { flag: "wx" });
    },
    async probe() { const n = frames ?? calls.at(-1).names.length; return { codec: "h264", width: 1378, height: 874, pixFmt: "yuv420p", frames: n, durationSec: n / calls.at(-1).fps, format: "mov,mp4" }; } };
}
/** A sealed run: recordings listed in artifact-manifest.json whose hash is in summary.json. */
function makeRun(root, recordings, { outcomes = {} } = {}) {
  const dir = path.join(root, "run-1");
  const entries = Object.entries(recordings).map(([relative, events]) => {
    const file = writeRecording(path.join(dir, relative), events.list ?? events, events.options ?? {});
    return { path: relative, kind: "file", bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) };
  });
  fs.writeFileSync(path.join(dir, "artifact-manifest.json"), JSON.stringify({ schemaVersion: 2, entries }));
  const summary = { models: ["claude-opus-5.5", "gpt-6-luna"], scenarios: [{ id: "V01", name: "Launch" }, { id: "V06", name: "Resume" }],
    artifacts: { manifest: { path: "artifact-manifest.json", sha256: sha(fs.readFileSync(path.join(dir, "artifact-manifest.json"))) } } };
  const slots = [{ model: "claude-opus-5.5", scenario: "V01", outcome: outcomes.V01 ?? "pass" }, { model: "gpt-6-luna", scenario: "V06", outcome: outcomes.V06 ?? "fail" }];
  return { dir, summary, slots, integrityProblems: [] };
}
const EVENTS = [{ t: 0, out: "\x1b[2J\x1b[Hwelcome" }, { t: 500, phase: "print" }, { t: 1000, out: "\r\nanswer 42 in /Users/alice/work" }, { t: 2000, phase: "unicode" }, { t: 2500, out: "\r\n한글 🙂 done" }];

test("replay keeps SGR colours and attributes per cell and renders them from the fixed palette", async (t) => {
  const s = await screen(t, [{ t: 0, out: "\x1b[1;31mR\x1b[0m\x1b[38;2;1;2;3mG\x1b[48;5;200mZ\x1b[0m\x1b[3;4;7;2mI\x1b[0m\x1b[9;8mH" }]);
  assert.deepEqual(at(s, 0, 0), { ch: "R", w: 1, fg: 1, bg: -1, bold: true });
  assert.deepEqual(at(s, 0, 1), { ch: "G", w: 1, fg: "#010203", bg: -1 });
  assert.deepEqual(at(s, 0, 2), { ch: "Z", w: 1, fg: "#010203", bg: 200 });
  assert.deepEqual(at(s, 0, 3), { ch: "I", w: 1, fg: -1, bg: -1, italic: true, dim: true, underline: true, inverse: true });
  assert.deepEqual(at(s, 0, 4), { ch: "H", w: 1, fg: -1, bg: -1, strike: true, invisible: true });
  const html = renderScreenHTML(s);
  assert.match(html, /color:#cc0000;font-weight:700">R</);
  assert.match(html, new RegExp(`color:#010203;background:${PALETTE[200]}">Z<`));
  assert.match(html, /font-style:italic;text-decoration:underline">I</);
  assert.match(html, /text-decoration:line-through">H</);
});

test("cursor movement, erase and replay time select the exact screen state", async (t) => {
  const events = [{ t: 0, out: "hello world\r\nsecond line" }, { t: 100, out: "\x1b[1;7HX\x1b[2;1H\x1b[K\x1b[5;10Hpos" }, { t: 200, out: "\x1b[2J\x1b[Hfresh" }];
  const early = await screen(t, events, 99);
  assert.equal(rowText(early.rows[0]).trimEnd(), "hello world");
  assert.equal(rowText(early.rows[1]).trimEnd(), "second line");
  const mid = await screen(t, events, 150);
  assert.equal(rowText(mid.rows[0]).trimEnd(), "hello Xorld");
  assert.equal(rowText(mid.rows[1]).trim(), "");
  assert.equal(rowText(mid.rows[4]).trimEnd(), "         pos");
  const late = await screen(t, events, 200);
  assert.deepEqual(late.rows.map(r => rowText(r).trim()).filter(Boolean), ["fresh"]);
  const file = writeRecording(path.join(tmp(t), "back.jsonl"), events), replay = createReplay(readRecording(file));
  await replay.advance(150);
  await assert.rejects(replay.advance(100), RangeError);
  replay.dispose();
});

test("wide Korean and emoji cells take two columns, survive split UTF-8 frames and stay aligned in HTML", async (t) => {
  const bytes = Buffer.from("a한🙂b é!");
  const s = await screen(t, [{ t: 0, out: bytes.subarray(0, 2) }, { t: 1, out: bytes.subarray(2, 6) }, { t: 2, out: bytes.subarray(6) }]);
  assert.deepEqual(s.rows[0].cells.slice(0, 6).map(c => [c.ch, c.w]), [["a", 1], ["한", 2], ["", 0], ["🙂", 2], ["", 0], ["b", 1]]);
  assert.equal(rowText(s.rows[0]).trimEnd(), "a한🙂b é!");
  assert.deepEqual([at(s, 0, 7).ch, at(s, 0, 8).ch], ["é", "!"]);
  const html = renderScreenHTML(s);
  assert.match(html, /left:1ch;top:0px;width:2ch">&#xd55c;</);
  assert.match(html, /left:3ch;top:0px;width:2ch">&#x1f642;</);
  assert.match(html, /#frame\{display:inline-block;width:calc\(160ch \+ 28px\);[^}]*font:14px\/17px Menlo/, "frame ch units use the grid font");
  assert.match(html, /left:5ch;top:0px;width:2ch">b <\/span><span class="w" style="left:7ch;top:0px;width:1ch">e&#x301;</);
});

test("HTML escapes markup and quotes, is script-free ASCII and never links OSC 8 or URL text", async (t) => {
  const s = await screen(t, [{ t: 0, out: `<script>alert("x")</script> & 'q' \x1b]8;;https://evil.example/path\x07Click here\x1b]8;;\x07 https://plain.example/a?b=1` }]);
  const html = renderScreenHTML(s, { caption: `cap <img src=x onerror="y"> & 'z'` });
  assert.ok(/^[\x20-\x7e]*$/.test(html), "only printable ASCII");
  assert.deepEqual([...new Set([...html.matchAll(/<\/?([a-z!]+)/gi)].map(m => m[1].toLowerCase()))].sort(), ["!doctype", "body", "div", "head", "html", "meta", "span", "style", "title"]);
  assert.equal(/href|evil\.example|javascript:|url\(|@import/i.test(html), false);
  assert.match(html, /width:34ch">&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;q&#39; <\/span>/);
  assert.match(html, /left:34ch;top:0px;width:10ch;text-decoration:underline">Click here<\/span>/, "OSC 8 text keeps xterm's link underline but is plain text");
  assert.match(html, /left:44ch;top:0px;width:116ch"> https:\/\/plain\.example\/a\?b=1 +<\/span>/);
  assert.match(html, /cap &lt;img src=x onerror=&quot;y&quot;&gt; &amp; &#39;z&#39;/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.throws(() => renderScreenHTML({ cols: 0, rows: [] }), TypeError);
});

test("redaction replaces homes, temp paths, tokens and the user name with same-width placeholders and counts only", async (t) => {
  const hex = "0123456789abcdef0123456789abcdef01234567", b64 = "AbCdEfGh1234567890_-ZyXwVuTsRqPoNmLk";
  const line = `한 /Users/alice/proj /private/var/folders/ab/cd/T/x /tmp/ghcp-1/ws sk-ant-api03-abcdefghij ${hex} ${b64} ALICE@host END`;
  const s = await screen(t, [{ t: 0, out: line }]);
  const both = snap => rowText(snap.rows[0]) + rowText(snap.rows[1]);
  assert.equal(s.rows[1].wrapped, true);
  const before = both(s), end = before.indexOf("END");
  const { snapshot, counts } = redactSnapshot(s, rules);
  const after = both(snapshot);
  assert.deepEqual(counts, { home: 1, varFolders: 1, tmp: 1, secretKey: 1, longToken: 2, username: 1 });
  for (const secret of ["alice", "ALICE", "folders", "ghcp-1", "sk-ant", hex, b64]) assert.equal(after.includes(secret), false, secret);
  assert.ok(snapshot.rows.every(r => r.cells.length === 160));
  assert.equal([...after].length, [...before].length);
  assert.equal(after.indexOf("END"), end);
  assert.match(after, /^한 \[home\]·{6}\/proj \[tmp\]·{25} \[tmp\]·{9} \[token\]·{16} \[token\]·{33} \[token\]·{29} ·{5}@host END/);
  assert.equal(both(s), before, "input snapshot is not mutated");
  const wide = redactSnapshot(await screen(t, [{ t: 0, out: "/tmp/한글/x|OK" }]), rules).snapshot.rows[0];
  assert.equal(rowText(wide).indexOf("|OK"), 11);
  assert.ok(wide.cells.slice(0, 11).every(c => c.w === 1));
  assert.deepEqual(redactText("in /Users/alice/x", rules).counts.home, 1);
  assert.equal(redactText("in /Users/alice/x", rules).text, "in [home]······/x");
  assert.equal(redactText("alicex ALICE9 malice alice", rules).text, "alicex ·····9 malice ·····");
  assert.equal(redactText("user alice-smith", redactionRules({ home: "/h/x", username: "alice-smith" })).text, "user [user]·····");
});

test("a token soft-wrapped across two rows is redacted on both rows", async (t) => {
  const token = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
  const s = await screen(t, [{ t: 0, out: `${"x".repeat(150)} ${token} tail` }]);
  assert.equal(s.rows[1].wrapped, true);
  const { snapshot, counts } = redactSnapshot(s, rules);
  assert.equal(counts.secretKey, 1);
  const joined = rowText(snapshot.rows[0]) + rowText(snapshot.rows[1]);
  assert.equal(joined.includes("sk-"), false);
  assert.equal(joined.includes("0123"), false);
  assert.equal(joined.indexOf(" tail"), 151 + token.length);
});

test("masked sk- key displays (Claude Code's sk-ant-...tail) are redacted", () => {
  const tail = "0123456789abcdef0123";
  for (const line of [`ANTHROPIC_API_KEY: sk-ant-...${tail}`, `ANTHROPIC_API_KEY: sk-ant-…${tail}`, `key sk-...${tail}`]) {
    const { text, counts } = redactText(line, rules);
    assert.equal(text.includes(tail), false, line);
    assert.equal(counts.secretKey, 1, line);
    assert.equal([...text].length, [...line].length, line);
  }
  const line = `ANTHROPIC_API_KEY: sk-ant-...${tail}`, cells = [...line].map(ch => ({ ch, w: 1 }));
  const { snapshot, counts } = redactSnapshot({ cols: 30, rows: [{ wrapped: false, cells: cells.slice(0, 30) }, { wrapped: true, cells: cells.slice(30) }] }, rules);
  assert.equal(counts.secretKey, 1);
  assert.equal(snapshot.rows.map(rowText).join("").includes(tail), false);
  for (const keep of ["sk-... later", "task-...abcdef", "sk-ant-... ok"]) assert.equal(redactText(keep, rules).text, keep);
});

test("spec validation rejects bad times, speeds, paths, fields and oversized edits", () => {
  const segment = { slot: SLOT, recording: "terminal-1.jsonl", fromMs: 0, toMs: 1000 };
  const ok = parseSpec({ run: "r", video: { segments: [segment] }, stills: [{ summary: true }, { slot: SLOT, recording: "terminal-1.jsonl", atMs: 5, name: "unicode" }] });
  assert.deepEqual(ok.video, { fps: 10, segments: [{ ...segment, path: `slots/${SLOT}/terminal-1.jsonl`, speed: 1, caption: null }] });
  assert.equal(ok.stills[1].path, `slots/${SLOT}/terminal-1.jsonl`);
  for (const [raw, message] of [
    [{ run: "r" }, /video and\/or stills/],
    [{ video: { segments: [segment] } }, /spec.run/],
    [{ run: "r", video: { segments: [{ ...segment, toMs: 0 }] } }, /greater than fromMs/],
    [{ run: "r", video: { segments: [{ ...segment, fromMs: -1 }] } }, /fromMs must be a time/],
    [{ run: "r", video: { segments: [{ ...segment, toMs: NaN }] } }, /toMs must be a time/],
    [{ run: "r", video: { segments: [{ ...segment, speed: 0 }] } }, /speed must be/],
    [{ run: "r", video: { segments: [{ ...segment, speed: 64 }] } }, /speed must be/],
    [{ run: "r", video: { segments: [{ ...segment, recording: "../x.jsonl" }] } }, /file name inside the slot/],
    [{ run: "r", video: { segments: [{ ...segment, slot: "../etc" }] } }, /slot directory name/],
    [{ run: "r", video: { segments: [{ ...segment, extra: 1 }] } }, /unknown field extra/],
    [{ run: "r", video: { segments: [{ ...segment, caption: "a\u001b[2Jb" }] } }, /printable text/],
    [{ run: "r", video: { segments: [{ ...segment, toMs: 400_000 }] } }, /limit is 300 s/],
    [{ run: "r", video: { fps: 60, segments: [segment] } }, /fps must be/],
    [{ run: "r", video: { segments: [] } }, /1\.\.40 segments/],
    [{ run: "r", stills: [{ summary: false }] }, /summary must be true/],
    [{ run: "r", stills: [{ slot: SLOT, recording: "a.jsonl", atMs: 1, name: "Bad Name" }] }, /name must be/],
    [{ run: "r", stills: [] }, /no output/],
  ]) assert.throws(() => parseSpec(raw), message);
});

test("frame plans and cuts describe multi-recording edits in original time", () => {
  const a = `slots/${SLOT}/a.jsonl`, b = `slots/${SLOT2}/b.jsonl`;
  const segments = [{ path: a, fromMs: 1000, toMs: 3000, speed: 2 }, { path: a, fromMs: 5000, toMs: 5400, speed: 1 }, { path: b, fromMs: 0, toMs: 1000, speed: 4 }, { path: b, fromMs: 500, toMs: 900, speed: 1 }];
  const frames = planFrames({ fps: 10, segments });
  assert.deepEqual([0, 1, 2, 3].map(i => frames.filter(f => f.segment === i).length), [10, 4, 3, 4]);
  assert.deepEqual([frames[0].timeMs, frames[9].timeMs, frames[10].timeMs, frames[13].timeMs], [1000, 3000, 5000, 5400]);
  assert.deepEqual(frames.map(f => f.outputMs).slice(9, 12), [900, 1000, 1100]);
  assert.deepEqual(describeCuts(segments).map(c => [c.kind, c.omittedMs]), [["time-skip", 2000], ["recording-switch", undefined], ["rewind", undefined]]);
  assert.throws(() => planFrames({ fps: 30, segments: [{ path: a, fromMs: 0, toMs: 301_000, speed: 1 }] }), /limit is 9000/);
  const phases = [{ type: "phase", timeMs: 10, label: "seed" }, { type: "phase", timeMs: 20, label: "compact" }, { type: "phase", timeMs: 30, label: "recall" }];
  assert.deepEqual([phaseAt(phases, 5), phaseAt(phases, 20), phaseAt(phases, 99)], [null, "compact", "recall"]);
  assert.deepEqual(phasesIn(phases, 15, 30), ["seed", "compact", "recall"]);
  assert.equal(captionFor({ model: "gpt-6-luna", scenario: "V06", phase: "resume", timeMs: 83_400, speed: 4, note: "cold resume" }),
    "Edited replay of a real PTY recording · gpt-6-luna V06/resume · original t=01:23 · speed x4 · cold resume");
});

test("output directory must be new or empty and outside .verify-runs and the source run", (t) => {
  const root = tmp(t), runs = path.join(root, ".verify-runs"), run = path.join(root, "run");
  fs.mkdirSync(path.join(runs, "r1"), { recursive: true }); fs.mkdirSync(run);
  const forbidden = [runs, run];
  for (const [out, message] of [[path.join(runs, "media"), /inside/], [path.join(runs, "r1", "x"), /inside/], [runs, /inside/], [path.join(run, "media"), /inside/]]) {
    assert.throws(() => prepareOutputDir(out, { forbidden }), message);
  }
  fs.mkdirSync(path.join(root, "full")); fs.writeFileSync(path.join(root, "full", "keep"), "x");
  assert.throws(() => prepareOutputDir(path.join(root, "full"), { forbidden }), /non-empty/);
  fs.writeFileSync(path.join(root, "file"), "x");
  assert.throws(() => prepareOutputDir(path.join(root, "file"), { forbidden }), /not a directory/);
  fs.symlinkSync(path.join(runs, "r1"), path.join(root, "alias"));
  assert.throws(() => prepareOutputDir(path.join(root, "alias", "media"), { forbidden }), /inside/);
  fs.symlinkSync(path.join(root, "empty-target"), path.join(root, "link")); fs.mkdirSync(path.join(root, "empty-target"));
  assert.throws(() => prepareOutputDir(path.join(root, "link"), { forbidden }), /not a directory/);
  assert.deepEqual(prepareOutputDir(path.join(root, "new"), { forbidden }), { dir: path.join(root, "new"), created: true });
  fs.mkdirSync(path.join(root, "empty"));
  assert.deepEqual(prepareOutputDir(path.join(root, "empty"), { forbidden }), { dir: path.join(root, "empty"), created: false });
  assert.throws(() => parseRenderArgs(["--spec", "a.json"]), /Usage/);
  assert.throws(() => parseRenderArgs(["--spec", "a.json", "--out", "o", "--force"]), /Unknown argument/);
  assert.deepEqual(parseRenderArgs(["--spec=a.json", "--out", "o"]), { spec: "a.json", out: "o", help: false });
});

test("output guard compares on-disk letter case, so a case-variant path cannot land inside the run", (t) => {
  const root = tmp(t), runs = path.join(root, "Repo", ".verify-runs"), run = path.join(runs, "Run-1");
  fs.mkdirSync(run, { recursive: true });
  if (!fs.existsSync(path.join(root, "REPO", ".VERIFY-RUNS"))) return t.skip("case-sensitive filesystem");
  for (const out of [path.join(root, "repo", ".verify-runs", "run-1", "media"), path.join(root, "Repo", ".VERIFY-RUNS", "x"), path.join(root, "REPO", ".verify-runs", "RUN-1")]) {
    assert.throws(() => prepareOutputDir(out, { forbidden: [runs, run] }), /Refusing output inside/, out);
  }
  assert.throws(() => prepareOutputDir(path.join(run, "media"), { forbidden: [path.join(root, "repo", ".VERIFY-RUNS", "run-1")] }), /Refusing output inside/, "case-variant forbidden root");
  assert.deepEqual(fs.readdirSync(run), []);
  assert.deepEqual(prepareOutputDir(path.join(root, "repo", "media"), { forbidden: [runs, run] }), { dir: path.join(root, "Repo", "media"), created: true });
});

test("multi-recording render writes exclusive outputs and a manifest with source and output SHA256, never redacted values", async (t) => {
  const root = tmp(t), a = `slots/${SLOT}/terminal-a.jsonl`, b = `slots/${SLOT2}/terminal-b.jsonl`;
  const run = makeRun(root, { [a]: { list: EVENTS, options: { endMs: 3000 } }, [b]: { list: [{ t: 0, out: "resumed sk-ant-secretsecret1234" }, { t: 100, phase: "resume" }, { t: 900, out: "\r\nok" }], options: { launch: "launch-2", endMs: 1200 } } });
  const spec = parseSpec({ run: run.dir, video: { fps: 5, segments: [{ slot: SLOT, recording: "terminal-a.jsonl", fromMs: 0, toMs: 3000, speed: 2, caption: "print then unicode /Users/alice/proj sk-ant-secretsecret1234" },
    { slot: SLOT2, recording: "terminal-b.jsonl", fromMs: 0, toMs: 1200 }] }, stills: [{ slot: SLOT, recording: "terminal-a.jsonl", atMs: 2600, name: "unicode" }, { summary: true, caption: "card for /Users/alice/proj" }] });
  const out = path.join(root, "media"), tmpRoot = path.join(root, "frames");
  fs.mkdirSync(out); fs.mkdirSync(tmpRoot);
  const rasterizer = stubRasterizer(), encoder = stubEncoder();
  const manifest = await renderMedia({ spec, run, out, rasterizer, encoder, rules, tmpRoot });
  assert.deepEqual(fs.readdirSync(out).sort(), ["manifest.json", "still-01-unicode.png", "still-02.png", "video.mp4"]);
  assert.deepEqual(fs.readdirSync(tmpRoot), [], "temporary frames are removed");
  const saved = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(saved, manifest);
  for (const output of saved.outputs) assert.equal(output.sha256, sha(fs.readFileSync(path.join(out, output.file))), output.file);
  const [still, card, video] = saved.outputs;
  assert.deepEqual([still.kind, still.slot, still.model, still.scenario, still.phase, still.atMs, still.width, still.height], ["still", SLOT, "claude-opus-5.5", "V01", "unicode", 2600, 1377, 874]);
  assert.deepEqual(still.source, { path: a, sha256: sha(fs.readFileSync(path.join(run.dir, a))), bytes: fs.statSync(path.join(run.dir, a)).size, launch: "launch-1", endMs: 3000, capture: { complete: true, truncated: false, error: null } });
  assert.equal(still.redactions.home, 1);
  assert.deepEqual([card.kind, card.green, card.counts], ["summary", false, { pass: 1, fail: 1, blocked: 0, unknown: 0 }]);
  assert.equal(card.redactions.home, 1, "the card caption is redacted like every other caption");
  assert.deepEqual([video.kind, video.fps, video.frames, video.durationMs, video.width, video.height, video.encoder], ["video", 5, 14, 2800, 1378, 874, "libx264"]);
  assert.equal(encoder.calls[0].names.length, 14);
  assert.deepEqual(video.segments.map(s => [s.slot, s.source.path, s.source.launch, s.original, s.speed, s.frames, s.output, s.phases]), [
    [SLOT, a, "launch-1", { fromMs: 0, toMs: 3000 }, 2, 8, { fromMs: 0, toMs: 1600 }, ["print", "unicode"]],
    [SLOT2, b, "launch-2", { fromMs: 0, toMs: 1200 }, 1, 6, { fromMs: 1600, toMs: 2800 }, ["resume"]]]);
  assert.deepEqual(video.cuts, [{ afterSegment: 0, kind: "recording-switch", from: { source: a, ms: 3000 }, to: { source: b, ms: 0 } }]);
  assert.ok(video.redactions.secretKey > 0 && video.redactions.home > 0);
  assert.deepEqual(saved.redaction.rules.map(r => r.id), ["home", "varFolders", "tmp", "secretKey", "longToken", "username"]);
  assert.deepEqual(saved.tools, { node: process.version, xtermHeadless: "6.0.0", playwrightCore: "stub-playwright", chrome: "stub-chrome", ffmpeg: "ffmpeg stub", ffprobe: "ffprobe stub", encoder: "libx264" });
  assert.deepEqual(saved.run, { id: "run-1", green: false, counts: { pass: 1, fail: 1, blocked: 0, unknown: 0 }, expectedTotal: 4, problems: saved.run.problems });
  const text = JSON.stringify(saved) + rasterizer.pages.join("");
  for (const secret of ["alice", "secretsecret", "/Users/"]) assert.equal(text.includes(secret), false, secret);
  assert.ok(rasterizer.pages.some(p => p.includes("Edited replay of a real PTY recording &#xb7; claude-opus-5.5 V01/print &#xb7; original t=00:01 &#xb7; speed x2 &#xb7; print then unicode [home]&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;/proj [token]" + "&#xb7;".repeat(16))));
  assert.equal(video.segments[0].caption, `print then unicode [home]${"\u00b7".repeat(6)}/proj [token]${"\u00b7".repeat(16)}`, "manifest caption is the redacted text the frames show");
  assert.ok(rasterizer.pages.some(p => p.includes("gpt-6-luna V06/resume")));
  assert.ok(rasterizer.pages.length < 16, "identical frames are linked, not rasterized again");
  await assert.rejects(renderMedia({ spec: { ...spec, video: null }, run, out, rasterizer, rules }), /EEXIST/);
});

test("sources must be sealed, unchanged, inside the recording and belong to a run slot", async (t) => {
  const root = tmp(t), a = `slots/${SLOT}/terminal-a.jsonl`, run = makeRun(root, { [a]: EVENTS });
  const spec = over => parseSpec({ run: run.dir, stills: [{ slot: SLOT, recording: "terminal-a.jsonl", atMs: 100, ...over }] });
  const out = path.join(root, "out");
  fs.mkdirSync(out);
  const attempt = (s, r = run) => renderMedia({ spec: s, run: r, out, rasterizer: stubRasterizer(), rules });
  await assert.rejects(attempt(spec({ atMs: 2501 })), /after the recording ends/);
  await assert.rejects(attempt(spec({ slot: "claude-sonnet-5__V01" })), /not a slot of this run/);
  await assert.rejects(attempt(spec({ recording: "other.jsonl" })), /not a sealed artifact/);
  await assert.rejects(attempt(spec({}), { ...run, summary: {} }), /no sealed artifact manifest/);
  fs.appendFileSync(path.join(run.dir, "artifact-manifest.json"), " ");
  await assert.rejects(attempt(spec({})), /does not match the hash in summary.json/);
  const fresh = makeRun(path.join(root, "second"), { [a]: EVENTS });
  fs.appendFileSync(path.join(fresh.dir, a), "\n");
  await assert.rejects(attempt(spec({}), fresh), /differs from its sealed SHA256/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("CLI resolves the run from the spec, refuses a non-empty output and removes its own output on failure", async (t) => {
  const root = tmp(t), a = `slots/${SLOT}/terminal-a.jsonl`, run = makeRun(root, { [a]: EVENTS });
  const specFile = path.join(root, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ run: "run-1", video: { fps: 2, segments: [{ slot: SLOT, recording: "terminal-a.jsonl", fromMs: 0, toMs: 2000 }] }, stills: [{ summary: true }] }));
  const loaded = [];
  const deps = over => ({ loadRun: dir => { loaded.push(dir); return run; }, createRasterizer: async () => stubRasterizer(), createEncoder: async () => stubEncoder(),
    rules, rootDir: root, tmpRoot: root, log: () => {}, ...over });
  const manifest = await main(["--spec", specFile, "--out", path.join(root, "media")], deps());
  assert.equal(loaded[0], run.dir);
  assert.deepEqual(manifest.outputs.map(o => o.file), ["still-01.png", "video.mp4"]);
  await assert.rejects(main(["--spec", specFile, "--out", path.join(root, "media")], deps()), /non-empty/);
  await assert.rejects(main(["--spec", specFile, "--out", path.join(root, ".verify-runs", "x")], deps()), /inside/);
  let closed = false;
  await assert.rejects(main(["--spec", specFile, "--out", path.join(root, "broken")], deps({ createEncoder: async () => stubEncoder({ frames: 3 }),
    createRasterizer: async () => ({ ...stubRasterizer(), close: async () => { closed = true; throw new Error("close failed"); } }) })), /ffprobe rejected video.mp4/);
  assert.equal(closed, true);
  assert.equal(fs.existsSync(path.join(root, "broken")), false);
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith("ghcp-render-")), []);
});

test("results card shows stored outcomes and the re-assessed verdict without claiming a pass", () => {
  const run = { dir: "/runs/2026-09-25-abc", summary: { models: ["claude-opus-5.5", "gpt-6-<b>"], scenarios: [{ id: "V01", name: "Launch" }, { id: "V02", name: "Edit" }],
    claude: { version: "2.1.282 (Claude Code)" }, copilotSdk: { version: "1.0.14" } },
  slots: [{ model: "claude-opus-5.5", scenario: "V01", outcome: "pass" }, { model: "claude-opus-5.5", scenario: "V02", outcome: "blocked" }, { model: "gpt-6-<b>", scenario: "V01", outcome: "weird" }], integrityProblems: [] };
  const html = renderSummaryHTML(run);
  assert.match(html, /Verification run 2026-09-25-abc/);
  assert.match(html, /Not green: 1\/4 slots stored as pass, 1 problem</);
  assert.ok(/^[\x20-\x7e]*$/.test(html), "only printable ASCII");
  assert.equal(/Strict all-pass/.test(html), false);
  assert.match(html, /pass 1 &#xb7; fail 0 &#xb7; blocked 1 &#xb7; unknown 1/);
  assert.deepEqual(html.match(/(PASS|FAIL|BLOCKED|UNKNOWN|NOT RUN)(?= ?!?<)/g), ["PASS", "BLOCKED", "UNKNOWN", "NOT RUN"]);
  assert.match(html, /2\.1\.282 \(Claude Code\)/);
  assert.match(html, /gpt-6-&lt;b&gt;/);
  assert.throws(() => renderSummaryHTML({ summary: {} }), TypeError);
});

/** In-memory green assessment input (assessRun is structural; loadRun's replay is covered by verify-report tests). */
function greenRun(t, models, scenarios) {
  const preflight = { claude: { bin: "/fixture/claude", version: "fixture-cli", sha256: "d".repeat(64) }, plugins: [], cleanup: { ok: true },
    scenarios: Object.fromEntries(SCENARIOS.map(s => [s.id, { ok: true }])) };
  const slots = models.flatMap(model => scenarios.map(scenario => {
    const input = makeSlot(t, scenario.id, model);
    input.evidence.facts.preflight = structuredClone(preflight);
    const slot = { ...input, ...evaluateStoredSlot(input), durationMs: 1, cleanup: { ok: true, bridges: [{ ok: true }] } };
    slot.evidence.settings = { ok: true, files: [{ before: "c".repeat(64), after: "c".repeat(64) }] };
    assert.equal(slot.outcome, "pass", `${model} ${scenario.id}: ${slot.reason}`);
    return slot;
  }));
  const state = { git: { commit: "b".repeat(40), dirty: false }, fingerprint: { algorithm: "sha256", scope: FINGERPRINT_SCOPE, value: "e".repeat(64), files: 1 } };
  const summary = { ...createRunDefinition(models, scenarios), actualTotal: slots.length, mode: "live",
    claude: { realpath: "/fixture/claude", version: "fixture-cli", sha256: "d".repeat(64), endSha256: "d".repeat(64) },
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:03.000Z", userSettings: { intact: true, before: "missing", after: "missing" }, cleanup: { ok: true },
    provenance: { start: state, end: structuredClone(state), sources: { path: "sources/manifest.json", sha256: "a".repeat(64) } },
    artifacts: { slots: { path: "slots.jsonl", sha256: "f".repeat(64) }, manifest: { path: "artifact-manifest.json", sha256: "9".repeat(64) } } };
  return { dir: "/runs/green", summary, slots, integrityProblems: [] };
}

test("results card names a green focused run a focused pass, never the strict all-pass", (t) => {
  const focused = renderSummaryHTML(greenRun(t, PRIMARY_MODELS.slice(0, 1), [SCENARIOS[0]]));
  assert.match(focused, /Focused pass \(not a full-matrix pass\): 1\/1 slots passed</);
  assert.equal(/Strict all-pass/.test(focused), false);
  assert.match(renderSummaryHTML(greenRun(t, PRIMARY_MODELS, SCENARIOS)), /Strict all-pass: 36\/36 slots passed</);
});

test("results card shows DUPLICATE for a slot stored twice, as the report matrix does", () => {
  const html = renderSummaryHTML({ dir: "/runs/dup", summary: { models: ["claude-opus-5.5", "gpt-6-luna"], scenarios: [{ id: "V01", name: "Launch" }] },
    slots: [{ model: "claude-opus-5.5", scenario: "V01", outcome: "pass" }, { model: "claude-opus-5.5", scenario: "V01", outcome: "fail" }, { model: "gpt-6-luna", scenario: "V01", outcome: "duplicate" }], integrityProblems: [] });
  assert.deepEqual([...html.matchAll(/<td>.*?<\/td>/g)].map(m => m[0].replace(/<[^>]+>/g, "").trim()), ["DUPLICATE", "UNKNOWN"]);
});

test("Chrome setup steps are bounded: a hung route or page rejects and closes, a hung close rejects", async () => {
  const never = () => new Promise(() => {});
  const fake = ({ route = async () => {}, newPage = async () => ({ setDefaultTimeout() {} }), close = async () => {} } = {}) => {
    const calls = { close: 0 };
    return { calls, chromium: { launch: async () => ({ version: () => "fake", newContext: async () => ({ route, newPage }), close: () => (calls.close++, close()) }) } };
  };
  for (const [label, hung] of [["route", fake({ route: never })], ["page", fake({ newPage: never })]]) {
    const started = Date.now();
    await assert.rejects(chromeRasterizer({ timeoutMs: 50, chromium: hung.chromium }), new RegExp(`Chrome ${label} timed out after 50 ms`));
    assert.ok(Date.now() - started < 2000, label);
    assert.equal(hung.calls.close, 1, label);
  }
  const stuck = await chromeRasterizer({ timeoutMs: 50, chromium: fake({ close: never }).chromium });
  await assert.rejects(stuck.close(), /Chrome close timed out after 50 ms/);
});

test("CLI exits after a bounded grace period even when a handle (a Chrome that ignored close) stays open", () => {
  const url = new URL("../scripts/verify/render-recording.mjs", import.meta.url).href;
  for (const [args, status, stderr] of [[["--help"], 0, /^$/], [["--bogus"], 1, /Unknown argument: --bogus/]]) {
    const started = Date.now(), child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { cli } from ${JSON.stringify(url)}; setInterval(() => {}, 1000); cli(${JSON.stringify(args)}, { log: () => {} }, 100);`],
    { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    assert.deepEqual([child.status, child.signal], [status, null], child.stderr);
    assert.match(child.stderr, stderr);
    assert.ok(Date.now() - started < 15_000);
  }
});

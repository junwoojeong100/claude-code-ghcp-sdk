import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createRecording, readRecording } from "../scripts/verify/recording.mjs";

const info = { launch: "launch-1", session: "session-1" };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-recording-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "output.jsonl") };
}
function recorded(t) {
  const { root, file } = fixture(t);
  const capture = createRecording(file, info);
  capture.output(Buffer.from("hello"));
  capture.phase("ready");
  capture.finish();
  const records = fs.readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse);
  return { root, file, records };
}
function store(file, records) {
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
function bytesOf(frames) {
  return Buffer.concat(frames.filter((frame) => frame.type === "output").map((frame) => Buffer.from(frame.data, "base64")));
}

test("split UTF-8, ANSI and binary bytes round-trip exactly, with no input or configuration records", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, { ...info, argv: ["SECRET_PROMPT"], settings: {}, env: { SECRET: "value" } });
  const bytes = Buffer.from("한글🙂\x1b[2J\x1b[48;5;20m\x00\r\n");
  capture.output(bytes.subarray(0, 1));
  capture.phase("turn-1.ready");
  capture.output(bytes.subarray(1, 6));
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, bytes.length - 6);
  capture.output(view);
  capture.output(Buffer.alloc(0));
  const result = capture.finish();
  assert.equal(result.state, "complete");
  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.truncated, false);
  assert.equal(result.frames, 4);
  assert.equal(result.outputBytes, bytes.length);
  assert.equal(result.fileBytes, fs.statSync(file).size);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { header, frames, footer } = readRecording(file);
  assert.deepEqual(header, { type: "header", schema: "ghcp-terminal-output", version: 1, cols: 160, rows: 48,
    ...info, seq: 0, timeMs: 0 });
  assert.deepEqual(bytesOf(frames), bytes);
  assert.equal(footer.outputBytes, bytes.length);
  assert.equal(footer.frames, 4);
  assert.equal(fs.readFileSync(file, "utf8").includes("SECRET"), false);
  const ordered = [header, ...frames, footer];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(ordered[i].seq, i);
    assert.ok(ordered[i].timeMs >= ordered[i - 1].timeMs);
  }
});

test("time is monotonic relative to the capture start even if a clock sample regresses", (t) => {
  const { file } = fixture(t);
  const times = [100, 105, 102, 104];
  t.mock.method(performance, "now", () => times.shift());
  const capture = createRecording(file, info);
  capture.output(Buffer.from("a"));
  capture.phase("ready");
  capture.finish();
  const { frames, footer } = readRecording(file);
  assert.deepEqual([...frames, footer].map((frame) => frame.timeMs), [5, 5, 5]);
});

for (const [options, expected] of [
  [{}, "complete"],
  [{ complete: false }, "incomplete"],
  [{ error: "PROCESS_FAILED" }, "error"],
]) {
  test(`explicit finalization distinguishes ${expected} capture from an unfinished file`, (t) => {
    const { file } = fixture(t);
    const capture = createRecording(file, info);
    assert.throws(() => readRecording(file));
    const result = capture.finish(options);
    assert.equal(result.state, expected);
    assert.equal(result.complete, expected === "complete");
    const { frames, footer } = readRecording(file);
    assert.equal(frames.length, 0);
    assert.equal(footer.complete, expected === "complete");
    assert.equal(footer.error, options.error ?? null);
    const before = fs.readFileSync(file);
    assert.deepEqual(capture.finish(), result);
    assert.deepEqual(capture.output(Buffer.from("ignored")), result);
    assert.deepEqual(capture.phase("ignored"), result);
    assert.deepEqual(fs.readFileSync(file), before);
    result.state = "mutated";
    assert.equal(capture.status().state, expected);
  });
}

test("byte cap includes JSONL overhead and footer, stops capture and preserves a valid truncated prefix", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, { ...info, maxBytes: 1024 });
  for (let i = 0; i < 30; i++) capture.output(Buffer.alloc(32, i));
  const result = capture.finish();
  assert.equal(result.state, "truncated");
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.error, null);
  assert.ok(result.outputBytes > 0 && result.outputBytes < 32 * 30);
  assert.ok(result.fileBytes <= 1024);
  assert.equal(fs.statSync(file).size, result.fileBytes);
  const { footer, frames } = readRecording(file, { maxBytes: 1024 });
  assert.equal(footer.truncated, true);
  assert.equal(footer.outputBytes, bytesOf(frames).length);
  const before = fs.statSync(file).size;
  capture.output(Buffer.alloc(1024 * 1024));
  assert.equal(fs.statSync(file).size, before);
});

test("large single output is chunked and the default hard cap is eight MiB", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, info);
  const result = capture.output(Buffer.alloc(9 * 1024 * 1024, 0xab));
  assert.equal(result.state, "truncated");
  assert.ok(result.fileBytes <= 8 * 1024 * 1024);
  assert.ok(result.fileBytes > 7 * 1024 * 1024);
  const { frames, footer } = readRecording(file);
  for (const frame of frames) assert.ok(Buffer.from(frame.data, "base64").length <= 48 * 1024);
  assert.equal(footer.outputBytes, result.outputBytes);
  assert.deepEqual(bytesOf(frames), Buffer.alloc(result.outputBytes, 0xab));
});

test("frame cap includes phase frames but excludes header and reserved footer", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, { ...info, maxFrames: 2 });
  capture.output(Buffer.from("one"));
  capture.phase("ready");
  const result = capture.output(Buffer.from("omitted"));
  assert.equal(result.state, "truncated");
  const { frames, footer } = readRecording(file, { maxFrames: 2 });
  assert.equal(frames.length, 2);
  assert.equal(footer.seq, 3);
  assert.equal(footer.truncated, true);
  assert.deepEqual(bytesOf(frames), Buffer.from("one"));
  assert.throws(() => readRecording(file, { maxFrames: 1 }));
});

test("partial synchronous writes are completed without losing bytes", (t) => {
  const { file } = fixture(t);
  const write = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd, buffer, offset, length) => write(fd, buffer, offset, Math.min(length, 7)));
  const capture = createRecording(file, info);
  capture.output(Buffer.from("hello\x1b[31m"));
  assert.equal(capture.finish().state, "complete");
  assert.deepEqual(bytesOf(readRecording(file).frames), Buffer.from("hello\x1b[31m"));
});

for (const stage of ["header", "output", "footer", "partial-output"]) {
  test(`${stage} write failure is explicit and does not throw or report completion`, (t) => {
    const { file } = fixture(t);
    const write = fs.writeSync;
    let fail = stage === "header", partial = stage === "partial-output";
    t.mock.method(fs, "writeSync", (fd, buffer, offset, length) => {
      if (!fail) return write(fd, buffer, offset, length);
      if (partial) { partial = false; return write(fd, buffer, offset, Math.min(length, 9)); }
      throw Object.assign(new Error("SECRET error detail"), { code: "ENOSPC" });
    });
    const capture = createRecording(file, info);
    if (stage === "output" || stage === "partial-output") fail = true;
    assert.doesNotThrow(() => capture.output(Buffer.from("hello")));
    fail = true;
    const result = capture.finish();
    assert.equal(result.state, "error");
    assert.equal(result.complete, false);
    assert.equal(result.error, "ENOSPC");
    assert.equal(result.fileBytes, fs.statSync(file).size);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.deepEqual(capture.phase("ignored"), result);
    assert.throws(() => readRecording(file));
  });
}

test("close failure is reported explicitly, even when footer writing succeeded", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, info);
  const close = fs.closeSync;
  let fail = true;
  t.mock.method(fs, "closeSync", (fd) => {
    close(fd);
    if (fail) { fail = false; throw Object.assign(new Error("close failed"), { code: "EIO" }); }
  });
  assert.equal(capture.finish().error, "EIO");
  assert.equal(capture.status().complete, false);
});

test("zero-byte writes stop capture rather than spinning", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, info);
  t.mock.method(fs, "writeSync", () => 0);
  const result = capture.output(Buffer.from("hello"));
  assert.equal(result.state, "error");
  assert.equal(result.complete, false);
});

test("exclusive creation never overwrites an existing file", (t) => {
  const { file } = recorded(t);
  const before = fs.readFileSync(file);
  const capture = createRecording(file, info);
  assert.equal(capture.status().error, "EEXIST");
  assert.equal(capture.finish().complete, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("missing parents return an explicit capture error without creating directories", (t) => {
  const { root } = fixture(t);
  const capture = createRecording(path.join(root, "absent", "recording.jsonl"), info);
  assert.equal(capture.status().error, "ENOENT");
  assert.equal(fs.existsSync(path.join(root, "absent")), false);
});

test("reader and writer reject symlink files and symlinked ancestors", (t) => {
  const { root, file } = recorded(t);
  const before = fs.readFileSync(file);
  const link = path.join(root, "link.jsonl");
  fs.symlinkSync(file, link);
  assert.throws(() => readRecording(link));
  assert.equal(createRecording(link, info).status().state, "error");
  const real = path.join(root, "directory");
  fs.mkdirSync(real);
  const linkedDir = path.join(root, "linked-directory");
  fs.symlinkSync(real, linkedDir);
  fs.copyFileSync(file, path.join(real, "existing.jsonl"));
  assert.throws(() => readRecording(path.join(linkedDir, "existing.jsonl")));
  assert.equal(createRecording(path.join(linkedDir, "new.jsonl"), info).status().state, "error");
  assert.equal(fs.existsSync(path.join(real, "new.jsonl")), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => readRecording(real));
});

for (const [name, mutate] of [
  ["schema", (r) => { r[0].schema = "other"; }],
  ["version", (r) => { r[0].version = 2; }],
  ["columns", (r) => { r[0].cols = 80; }],
  ["rows", (r) => { r[0].rows = 24; }],
  ["header time", (r) => { r[0].timeMs = 1; }],
  ["header sequence", (r) => { r[0].seq = 1; }],
  ["extra settings", (r) => { r[0].settings = {}; }],
  ["object launch", (r) => { r[0].launch = { argv: [] }; }],
  ["oversized session", (r) => { r[0].session = "x".repeat(65); }],
  ["missing header", (r) => { r.shift(); }],
  ["negative timestamp", (r) => { r[1].timeMs = -1; }],
  ["non-finite timestamp", (r) => { r[1].timeMs = Infinity; }],
  ["string timestamp", (r) => { r[1].timeMs = "1"; }],
  ["backward timestamp", (r) => { r[1].timeMs = 2; r[2].timeMs = 1; }],
  ["backward footer time", (r) => { r[2].timeMs = 2; r[3].timeMs = 1; }],
  ["duplicate sequence", (r) => { r[2].seq = 1; }],
  ["sequence gap", (r) => { r[1].seq = 2; }],
  ["footer sequence", (r) => { r[3].seq = 4; }],
  ["empty output", (r) => { r[1].data = ""; }],
  ["missing base64 padding", (r) => { r[1].data = "YQ"; }],
  ["noncanonical base64 bits", (r) => { r[1].data = "YR=="; }],
  ["base64 whitespace", (r) => { r[1].data = "YQ==\n"; }],
  ["base64 junk", (r) => { r[1].data = "!!!!"; }],
  ["object base64", (r) => { r[1].data = {}; }],
  ["oversized frame", (r) => { r[1].data = Buffer.alloc(48 * 1024 + 1).toString("base64"); }],
  ["input record", (r) => { r[1].type = "input"; }],
  ["null frame", (r) => { r[1] = null; }],
  ["prompt phase", (r) => { r[2].label = "please execute my prompt"; }],
  ["ANSI phase", (r) => { r[2].label = "\x1b[31m"; }],
  ["long phase", (r) => { r[2].label = "x".repeat(65); }],
  ["object phase", (r) => { r[2].label = {}; }],
  ["missing footer", (r) => { r.pop(); }],
  ["wrong footer", (r) => { r[3].type = "output"; }],
  ["wrong byte total", (r) => { r[3].outputBytes++; }],
  ["wrong frame total", (r) => { r[3].frames++; }],
  ["non-boolean completion", (r) => { r[3].complete = "true"; }],
  ["non-boolean truncation", (r) => { r[3].truncated = 0; }],
  ["contradictory truncation", (r) => { r[3].truncated = true; }],
  ["contradictory error", (r) => { r[3].error = "EIO"; }],
  ["unbounded error text", (r) => { r[3].complete = false; r[3].error = "a private error message"; }],
  ["trailing record", (r) => { r.push({ ...r[3], seq: 4 }); }],
]) {
  test(`reader rejects invalid ${name}`, (t) => {
    const { file, records } = recorded(t);
    mutate(records);
    store(file, records);
    assert.throws(() => readRecording(file));
  });
}

for (const [name, contents] of [
  ["empty file", ""],
  ["executable text", "throw new Error('MUST_NOT_EXECUTE');\n"],
  ["invalid JSON", "{\n"],
  ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
  ["excessive newlines", "\n".repeat(50_010)],
  ["oversized file", Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)],
]) {
  test(`reader rejects ${name} as data`, (t) => {
    const { file } = fixture(t);
    fs.writeFileSync(file, contents);
    assert.throws(() => readRecording(file));
  });
}

test("reader rejects a missing final newline and enforces a tighter file byte cap", (t) => {
  const { file, records } = recorded(t);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
  assert.throws(() => readRecording(file));
  fs.writeFileSync(file, " ".repeat(1025));
  assert.throws(() => readRecording(file, { maxBytes: 1024 }));
});

for (const options of [
  { launch: "private prompt" }, { session: {} }, { launch: "x".repeat(65) },
  { maxBytes: 1023 }, { maxBytes: 8 * 1024 * 1024 + 1 }, { maxBytes: Infinity },
  { maxFrames: 0 }, { maxFrames: 50_001 }, { maxFrames: 1.5 },
]) {
  test(`invalid capture option ${JSON.stringify(options)} fails before file creation`, (t) => {
    const { file } = fixture(t);
    const capture = createRecording(file, { ...info, ...options });
    assert.equal(capture.status().state, "error");
    assert.equal(capture.finish().complete, false);
    assert.equal(fs.existsSync(file), false);
  });
}

test("unsafe phase, textual output and error messages fail capture explicitly", (t) => {
  const { root } = fixture(t);
  const cases = [
    (c) => c.phase("a private prompt"),
    (c) => c.phase({ prompt: "private" }),
    (c) => c.output("not raw bytes"),
    (c) => c.finish({ error: "a private failure message" }),
  ];
  for (const [index, invoke] of cases.entries()) {
    const file = path.join(root, `${index}.jsonl`);
    const capture = createRecording(file, info);
    assert.equal(invoke(capture).state, "error");
    assert.equal(capture.status().complete, false);
    assert.equal(fs.readFileSync(file, "utf8").includes("private"), false);
  }
});

test("output frames keep echoed prompt text verbatim: the recording is as sensitive as the raw log", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, info);
  const echoed = Buffer.from("\x1b[2K❯ Remember the inert project label VERIFY_TESTNONCE\r\n");
  capture.output(echoed);
  assert.equal(capture.finish().complete, true);
  assert.deepEqual(bytesOf(readRecording(file).frames), echoed);
});

test("a capture error leaves no footer and the file is refused, as DIAGNOSTICS says", (t) => {
  const { file } = fixture(t);
  const capture = createRecording(file, info);
  capture.output(Buffer.from("hello"));
  t.mock.method(fs, "writeSync", () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
  assert.equal(capture.output(Buffer.from("world")).state, "error");
  t.mock.restoreAll();
  assert.equal(capture.finish({ complete: true }).state, "error");
  assert.deepEqual(fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).type), ["header", "output"]);
  assert.throws(() => readRecording(file), { code: "INVALID_RECORDING" });
  const doc = (name) => {
    const text = fs.readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
    const at = text.indexOf("`terminal-output-<launchId>.jsonl`");
    assert.notEqual(at, -1, name);
    return text.slice(text.lastIndexOf("\n- ", at), text.indexOf("\n- ", at + 1)).replace(/\s+/g, " ");
  };
  const en = doc("DIAGNOSTICS.md"), ko = doc("DIAGNOSTICS_KO.md");
  assert.doesNotMatch(en, /footer[^.]*failed/);
  assert.match(en, /capture error[^.]*no footer and the renderer rejects it/);
  assert.doesNotMatch(ko, /마지막 줄은[^.]*실패했는지/);
  assert.match(ko, /녹화 오류[^.]*마지막 줄이 없고 렌더러가 받지 않습니다/);
});

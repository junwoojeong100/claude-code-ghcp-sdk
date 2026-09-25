import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MAX_BYTES = 8 * 1024 * 1024, MAX_FRAMES = 50_000;
const CHUNK_BYTES = 48 * 1024, FOOTER_RESERVE = 512;
const identifier = (s) => typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(s);
const errorCode = (s) => typeof s === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(s);
function check(ok) {
  if (!ok) throw Object.assign(new Error("Invalid terminal recording"), { code: "INVALID_RECORDING" });
}
function limits({ maxBytes = MAX_BYTES, maxFrames = MAX_FRAMES }) {
  check(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= MAX_BYTES);
  check(Number.isSafeInteger(maxFrames) && maxFrames >= 1 && maxFrames <= MAX_FRAMES);
  return { maxBytes, maxFrames };
}
function keys(record, names) {
  check(record !== null && typeof record === "object" && !Array.isArray(record));
  check(Object.keys(record).sort().join(" ") === names.split(" ").sort().join(" "));
}
function openFile(file, create) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let ancestor = root;
  // Check from the root down: never traverse an unchecked, symlinked ancestor.
  for (const part of path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    check(fs.lstatSync(ancestor).isDirectory());
  }
  const flags = create ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(absolute, flags | fs.constants.O_NOFOLLOW, 0o600);
  try { check(fs.fstatSync(fd).isFile()); return fd; }
  catch (error) { fs.closeSync(fd); throw error; }
}

// Capture only PTY output. launch/session/phase are identifiers, never prompts or argv.
// complete describes capture finalization, not whether verification passed.
export function createRecording(file, options = {}) {
  let fd, maxBytes, maxFrames, elapsed = 0;
  const started = performance.now();
  const state = { state: "recording", complete: false, truncated: false, error: null,
    frames: 0, outputBytes: 0, fileBytes: 0 };
  const status = () => ({ ...state });
  const stamp = () => ({ seq: state.frames + 1, timeMs: (elapsed = Math.max(elapsed, performance.now() - started)) });
  const fail = (error) => {
    state.state = "error";
    state.complete = false;
    state.error = errorCode(error?.code) ? error.code : "CAPTURE_ERROR";
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
    return status();
  };
  const encode = (record) => Buffer.from(`${JSON.stringify(record)}\n`);
  const write = (line) => {
    check(state.fileBytes + line.length <= maxBytes);
    for (let offset = 0; offset < line.length;) {
      const count = fs.writeSync(fd, line, offset, line.length - offset);
      check(Number.isInteger(count) && count > 0 && count <= line.length - offset);
      offset += count;
      state.fileBytes += count;
    }
  };
  const finish = ({ complete = true, error = null } = {}) => {
    if (state.state !== "recording") return status();
    try {
      check(typeof complete === "boolean" && (error === null || errorCode(error)));
      state.complete = complete && !state.truncated && error === null;
      state.error = error;
      write(encode({ type: "footer", ...stamp(), complete: state.complete, truncated: state.truncated,
        error, frames: state.frames, outputBytes: state.outputBytes }));
      fs.closeSync(fd);
      fd = undefined;
      state.state = error ? "error" : state.truncated ? "truncated" : state.complete ? "complete" : "incomplete";
      return status();
    } catch (error) { return fail(error); }
  };
  const frame = (record, bytes = 0) => {
    const line = encode({ ...record, ...stamp() });
    if (state.frames >= maxFrames || state.fileBytes + line.length + FOOTER_RESERVE > maxBytes) {
      state.truncated = true;
      finish({ complete: false });
      return;
    }
    write(line);
    state.frames++;
    state.outputBytes += bytes;
  };
  try {
    ({ maxBytes, maxFrames } = limits(options));
    check(identifier(options.launch) && identifier(options.session));
    fd = openFile(file, true);
    write(encode({ type: "header", schema: "ghcp-terminal-output", version: 1, cols: 160, rows: 48,
      launch: options.launch, session: options.session, seq: 0, timeMs: 0 }));
  } catch (error) { fail(error); }
  return {
    status, finish,
    output(bytes) {
      if (state.state !== "recording") return status();
      try {
        check(bytes instanceof Uint8Array);
        for (let offset = 0; offset < bytes.byteLength && state.state === "recording"; offset += CHUNK_BYTES) {
          const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, Math.min(CHUNK_BYTES, bytes.byteLength - offset));
          frame({ type: "output", data: chunk.toString("base64") }, chunk.length);
        }
        return status();
      } catch (error) { return fail(error); }
    },
    phase(label) {
      if (state.state !== "recording") return status();
      try { check(identifier(label)); frame({ type: "phase", label }); return status(); }
      catch (error) { return fail(error); }
    },
  };
}

// Data-only, bounded parsing; unfinished or malformed files throw, never replay partially.
export function readRecording(file, options = {}) {
  const { maxBytes, maxFrames } = limits(options);
  const fd = openFile(file, false);
  let length = 0, text;
  try {
    check(fs.fstatSync(fd).size <= maxBytes);
    const buffer = Buffer.alloc(maxBytes + 1);
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    check(length <= maxBytes);
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
  const lines = text.split("\n", maxFrames + 4);
  check(lines.length >= 3 && lines.length <= maxFrames + 3 && lines.pop() === "");
  const records = lines.map((line) => JSON.parse(line));
  const header = records.shift(), footer = records.pop(), frames = records;
  keys(header, "type schema version cols rows launch session seq timeMs");
  check(header.type === "header" && header.schema === "ghcp-terminal-output" && header.version === 1);
  check(header.cols === 160 && header.rows === 48 && header.seq === 0 && header.timeMs === 0);
  check(identifier(header.launch) && identifier(header.session));
  let time = 0, outputBytes = 0;
  for (const [index, record] of [...frames, footer].entries()) {
    check(record !== null && typeof record === "object");
    check(record.seq === index + 1 && Number.isFinite(record.timeMs) && record.timeMs >= time);
    time = record.timeMs;
    if (index === frames.length) break;
    if (record.type === "output") {
      keys(record, "type seq timeMs data");
      check(typeof record.data === "string" && record.data.length > 0 && record.data.length <= CHUNK_BYTES / 3 * 4);
      const bytes = Buffer.from(record.data, "base64");
      check(bytes.toString("base64") === record.data);
      outputBytes += bytes.length;
    } else {
      keys(record, "type seq timeMs label");
      check(record.type === "phase" && identifier(record.label));
    }
  }
  keys(footer, "type seq timeMs complete truncated error frames outputBytes");
  check(footer.type === "footer" && footer.frames === frames.length && footer.outputBytes === outputBytes);
  check(typeof footer.complete === "boolean" && typeof footer.truncated === "boolean");
  check(footer.error === null || errorCode(footer.error));
  check(!footer.complete || (!footer.truncated && footer.error === null));
  return { header, frames, footer };
}

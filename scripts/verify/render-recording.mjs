#!/usr/bin/env node
/** Offline docs media: sealed output-only PTY recordings -> redacted, labelled replay stills/video. No model calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { isEntryPoint } from "../../src/entry-point.mjs";
import { readRecording } from "./recording.mjs";
import { assessRun } from "./summary.mjs";

const { Terminal } = xterm;
const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const USAGE = "Usage: node scripts/verify/render-recording.mjs --spec <spec.json> --out <new directory>";
const VIDEO_TITLE = "Edited replay of real PTY recordings";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = message => { throw Object.assign(new Error(message), { code: "INVALID_SPEC" }); };
const round = v => Math.round(v * 1000) / 1000;

// Replay with modern terminal widths (Hangul/CJK and emoji presentation = 2 columns), as a real terminal shows them.
const WIDE = [[0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x2fffd], [0x30000, 0x3fffd]];
const widths = new Map();
export function cellWidth(cp) {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  let width = widths.get(cp);
  if (width === undefined) {
    const ch = String.fromCodePoint(cp);
    width = /[\p{Mn}\p{Me}\p{Cf}]/u.test(ch) || (cp >= 0x1160 && cp <= 0x11ff) ? 0
      : /\p{Emoji_Presentation}/u.test(ch) || WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
    widths.set(cp, width);
  }
  return width;
}
// Same joining rule as xterm's built-in provider; only the width table differs.
const UNICODE = { version: "ghcp-render", wcwidth: cellWidth, charProperties(cp, preceding) {
  let width = cellWidth(cp), join = width === 0 && preceding !== 0;
  if (join) { const previous = preceding >> 1 & 3; if (!previous) join = false; else if (previous > width) width = previous; }
  return (width & 3) << 1 | (join ? 1 : 0);
} };

/** Incremental, forward-only replay of one parsed recording (readRecording output). */
export function createReplay(recording) {
  const { header, frames } = recording;
  const terminal = new Terminal({ cols: header.cols, rows: header.rows, scrollback: 0, allowProposedApi: true });
  terminal.unicode.register(UNICODE);
  terminal.unicode.activeVersion = UNICODE.version;
  const decoder = new StringDecoder("utf8");
  let next = 0, time = 0;
  return {
    get timeMs() { return time; },
    async advance(ms) {
      if (!(ms >= time)) throw new RangeError("Replay time cannot move backwards");
      let text = "";
      for (; next < frames.length && frames[next].timeMs <= ms; next++) {
        if (frames[next].type === "output") text += decoder.write(Buffer.from(frames[next].data, "base64"));
      }
      time = ms;
      if (text) await new Promise(resolve => terminal.write(text, resolve));
    },
    snapshot: () => snapshotTerminal(terminal),
    dispose: () => terminal.dispose(),
  };
}

const colorOf = (isDefault, isRGB, value) => isDefault ? -1 : isRGB ? `#${value.toString(16).padStart(6, "0")}` : value;
/** Screen cells: fg/bg are -1 (default), a 0-255 palette index or "#rrggbb"; w is 0 for a wide char's second column. */
export function snapshotTerminal(terminal) {
  const buffer = terminal.buffer.active, cell = buffer.getNullCell(), rows = [];
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y), cells = [];
    for (let x = 0; x < terminal.cols; x++) {
      if (!line?.getCell(x, cell)) { cells.push({ ch: "", w: 1, fg: -1, bg: -1 }); continue; }
      const entry = { ch: cell.getChars(), w: cell.getWidth(), fg: colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
        bg: colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()) };
      if (cell.isBold()) entry.bold = true;
      if (cell.isItalic()) entry.italic = true;
      if (cell.isDim()) entry.dim = true;
      if (cell.isUnderline()) entry.underline = true;
      if (cell.isInverse()) entry.inverse = true;
      if (cell.isStrikethrough()) entry.strike = true;
      if (cell.isInvisible()) entry.invisible = true;
      cells.push(entry);
    }
    rows.push({ wrapped: Boolean(line?.isWrapped), cells });
  }
  return { cols: terminal.cols, rows };
}
export const rowText = row => row.cells.map(c => c.w === 0 ? "" : c.ch || " ").join("");

export function phaseAt(frames, ms) {
  let label = null;
  for (const frame of frames) { if (frame.timeMs > ms) break; if (frame.type === "phase") label = frame.label; }
  return label;
}
export function phasesIn(frames, fromMs, toMs) {
  const labels = [phaseAt(frames, fromMs)];
  for (const f of frames) if (f.type === "phase" && f.timeMs > fromMs && f.timeMs <= toMs) labels.push(f.label);
  return labels.filter((label, i) => label !== null && label !== labels[i - 1]);
}

// Redaction runs on screen cells before any HTML exists; placeholders keep every column so the grid stays aligned.
const PATH_CHAR = String.raw`[^\s"'\x60<>|│]`;
const literal = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const realOr = p => { try { return fs.realpathSync(p); } catch { return p; } };
const accountName = () => { try { return os.userInfo().username; } catch { return process.env.USER ?? null; } };
export function redactionRules({ home = os.homedir(), username = accountName() } = {}) {
  const homes = [...new Set([home, home && realOr(home)])].filter(v => typeof v === "string" && v.length > 1 && v !== "/")
    .sort((a, b) => b.length - a.length);
  const rules = [];
  if (homes.length) rules.push({ id: "home", label: "[home]", description: "home directory path", pattern: new RegExp(homes.map(literal).join("|"), "g") });
  rules.push({ id: "varFolders", label: "[tmp]", description: "/var/folders or /private/var/folders path", pattern: new RegExp(String.raw`(?<![\w.~-])(?:/private)?/var/folders/${PATH_CHAR}*`, "g") });
  rules.push({ id: "tmp", label: "[tmp]", description: "/tmp or /private/tmp path", pattern: new RegExp(String.raw`(?<![\w.~-])(?:/private)?/tmp/${PATH_CHAR}+`, "g") });
  rules.push({ id: "secretKey", label: "[token]", description: "sk- (full or masked sk-...tail), gh*_ or github_pat_ key",
    pattern: /(?<![A-Za-z0-9_-])(?:sk-(?:[A-Za-z0-9_-]*(?:\.{3}|…)[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{8,})|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g });
  rules.push({ id: "longToken", label: "[token]", description: "32+ character hex/base64url run with letters and digits", pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    accept: s => /\d/.test(s) && /[A-Za-z]/.test(s) });
  if (typeof username === "string" && username.length >= 3) rules.push({ id: "username", label: "[user]", description: "local account name", pattern: new RegExp(`(?<![A-Za-z])${literal(username)}(?![A-Za-z])`, "gi") });
  return rules;
}
export const zeroCounts = rules => Object.fromEntries(rules.map(r => [r.id, 0]));
const placeholder = (label, n) => n >= label.length ? label + "·".repeat(n - label.length) : "·".repeat(n);
export function redactText(text, rules, counts = zeroCounts(rules)) {
  let out = text;
  for (const rule of rules) out = out.replace(rule.pattern, m => rule.accept && !rule.accept(m) ? m : (counts[rule.id]++, placeholder(rule.label, [...m].length)));
  return { text: out, counts };
}
/** Soft-wrapped rows are matched as one logical line; hard (application) wraps are not joined. */
export function redactSnapshot(snapshot, rules, counts = zeroCounts(rules)) {
  const rows = snapshot.rows.map(row => ({ wrapped: row.wrapped, cells: row.cells.map(cell => ({ ...cell })) }));
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && rows[end].wrapped) end++;
    const cells = rows.slice(start, end).flatMap(row => row.cells);
    for (const rule of rules) {
      let text = "";
      const owner = [];
      cells.forEach((cell, i) => { const s = cell.w === 0 ? "" : cell.ch || " "; text += s; for (let k = 0; k < s.length; k++) owner.push(i); });
      for (const match of text.matchAll(rule.pattern)) {
        if (!match[0] || (rule.accept && !rule.accept(match[0]))) continue;
        const from = owner[match.index];
        let to = owner[match.index + match[0].length - 1] + 1;
        while (to < cells.length && cells[to].w === 0) to++;
        const fill = placeholder(rule.label, to - from);
        for (let i = from; i < to; i++) Object.assign(cells[i], { ch: fill[i - from], w: 1 });
        counts[rule.id]++;
      }
    }
    start = end;
  }
  return { snapshot: { ...snapshot, rows }, counts };
}

// Fixed palette (xterm.js defaults + standard 256-colour cube/greys); media never depends on a viewer theme.
const hex2 = n => n.toString(16).padStart(2, "0");
const cube = v => v ? 55 + v * 40 : 0;
export const PALETTE = Object.freeze(["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
  ...Array.from({ length: 216 }, (_, i) => `#${hex2(cube(Math.floor(i / 36)))}${hex2(cube(Math.floor(i / 6) % 6))}${hex2(cube(i % 6))}`),
  ...Array.from({ length: 24 }, (_, i) => `#${hex2(8 + i * 10).repeat(3)}`)]);
const FG = "#e8e8e6", BG = "#141414", CELL_PX = 17, FONT = "14px/17px Menlo, 'SF Mono', Monaco, 'DejaVu Sans Mono', monospace";
const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Output is pure printable ASCII: markup characters become entities, everything else a numeric reference. */
export const escapeHTML = s => String(s).replace(/[^ !#-%(-;=?-~]/gu, c => ENTITY[c]
  ?? (/[\p{Cc}\p{Cs}]/u.test(c) ? "&#xfffd;" : `&#x${c.codePointAt(0).toString(16)};`));
const color = (v, fallback) => v === -1 ? fallback : Number.isInteger(v) && v >= 0 && v < 256 ? PALETTE[v]
  : typeof v === "string" && /^#[0-9a-f]{6}$/.test(v) ? v : fallback;
const mix = (a, b) => `#${[1, 3, 5].map(i => hex2(Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2))).join("")}`;
function cellStyle(c) {
  let fg = color(c.fg, FG), bg = color(c.bg, null);
  if (c.inverse) [fg, bg] = [bg ?? BG, fg];
  if (c.dim) fg = mix(fg, bg ?? BG);
  if (c.invisible) fg = bg ?? BG;
  const css = [];
  if (fg !== FG) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (c.bold) css.push("font-weight:700");
  if (c.italic) css.push("font-style:italic");
  const lines = [c.underline && "underline", c.strike && "line-through"].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(" ")}`);
  return css.join(";");
}
const PAGE = (title, width, body) => `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHTML(title)}</title><style>` +
  `html,body{margin:0;background:${BG}}#frame{display:inline-block;width:${width};background:${BG};font:${FONT}}` +
  `.t{position:relative;margin:12px 14px;font:${FONT};color:${FG};white-space:pre;overflow:hidden}` +
  `.t span{position:absolute;height:${CELL_PX}px}.w{text-align:center}` +
  `.cap{box-sizing:border-box;height:34px;padding:8px 14px;background:#1a1a19;border-top:1px solid #2c2c2a;color:#c3c2b7;` +
  `font:13px/18px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;white-space:pre;overflow:hidden;text-overflow:ellipsis}` +
  `</style></head><body><div id="frame">${body}</div></body></html>`;

/** Pure, script-free HTML for one snapshot: fixed grid (1 cell = 1ch x ${CELL_PX}px), no links, no external resources. */
export function renderScreenHTML(snapshot, { caption = null, title = VIDEO_TITLE } = {}) {
  const { cols, rows } = snapshot;
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > 500 || !Array.isArray(rows) || rows.length < 1 || rows.length > 300) throw new TypeError("Invalid screen snapshot");
  const out = [];
  rows.forEach((row, y) => {
    const spans = [];
    let run = null;
    const flush = () => { if (run && (run.style || run.text.trim())) spans.push(`<span style="left:${run.x}ch;top:${y * CELL_PX}px;width:${run.n}ch${run.style ? `;${run.style}` : ""}">${escapeHTML(run.text)}</span>`); run = null; };
    for (let x = 0; x < cols; x++) {
      const c = row.cells?.[x] ?? { ch: "", w: 1, fg: -1, bg: -1 };
      if (c.w === 0) continue;
      const ch = typeof c.ch === "string" && c.ch ? c.ch : " ", style = cellStyle(c), width = c.w === 2 && x + 1 < cols ? 2 : 1;
      if (width === 1 && /^[ -~]$/.test(ch) && run?.ascii && run.style === style) { run.text += ch; run.n++; continue; }
      flush();
      run = { x, n: width, text: ch, style, ascii: width === 1 && /^[ -~]$/.test(ch) };
      if (!run.ascii) { spans.push(`<span class="w" style="left:${x}ch;top:${y * CELL_PX}px;width:${width}ch${style ? `;${style}` : ""}">${escapeHTML(ch)}</span>`); run = null; }
    }
    flush();
    out.push(spans.join(""));
  });
  const screen = `<div class="t" style="width:${cols}ch;height:${rows.length * CELL_PX}px">${out.join("")}</div>`;
  return PAGE(title, `calc(${cols}ch + 28px)`, `${screen}${caption === null ? "" : `<div class="cap">${escapeHTML(caption)}</div>`}`);
}

const STATUS = { pass: ["#0ca30c", "PASS"], fail: ["#d03b3b", "FAIL"], blocked: ["#fab219", "BLOCKED"], unknown: ["#898781", "UNKNOWN"], missing: ["#898781", "NOT RUN"], duplicate: ["#898781", "DUPLICATE"] };
/** Pure results card from a loadRun() result. It shows stored outcomes and the re-assessed verdict, nothing else. */
export function renderSummaryHTML(run, { caption = null } = {}) {
  if (!plain(run?.summary) || !Array.isArray(run?.slots) || !Array.isArray(run?.integrityProblems) || typeof run?.dir !== "string") throw new TypeError("Summary card needs a run loaded with loadRun()");
  const { summary, slots } = run, assessment = assessRun(summary, slots, { integrityProblems: run.integrityProblems });
  const models = Array.isArray(summary.models) ? summary.models.filter(m => typeof m === "string") : [];
  const scenarios = (Array.isArray(summary.scenarios) ? summary.scenarios : []).filter(s => typeof s?.id === "string");
  const e = escapeHTML, runId = path.basename(run.dir), { counts, expectedTotal } = assessment, problems = assessment.problems.length;
  const verdict = assessment.green ? `${assessment.scope.kind === "full" ? "Strict all-pass" : "Focused pass (not a full-matrix pass)"}: ${counts.pass}/${expectedTotal} slots passed`
    : `Not green: ${counts.pass}/${expectedTotal ?? "?"} slots stored as pass, ${problems} problem${problems === 1 ? "" : "s"}`;
  const head = scenarios.map(s => `<th>${e(s.id)}<small>${e(s.name ?? "")}</small></th>`).join("");
  const body = models.map(model => `<tr><th class="m">${e(model)}</th>${scenarios.map(s => {
    const found = slots.filter(x => x?.model === model && x?.scenario === s.id);
    const state = !found.length ? "missing" : found.length > 1 ? "duplicate" : Object.hasOwn(STATUS, found[0].outcome) && !["missing", "duplicate"].includes(found[0].outcome) ? found[0].outcome : "unknown";
    const flagged = assessment.problems.some(p => typeof p === "string" && p.startsWith(`${model} × ${s.id}`));
    return `<td><i style="background:${STATUS[state][0]}"></i>${STATUS[state][1]}${flagged ? " !" : ""}</td>`;
  }).join("")}</tr>`).join("");
  const facts = [["Claude Code CLI", summary.claude?.version], ["Copilot SDK", summary.copilotSdk?.version], ["Node", summary.node],
    ["Policy", summary.policy?.id], ["Scope", assessment.scope?.kind], ["Started", summary.startedAt], ["Finished", summary.finishedAt]]
    .map(([k, v]) => `<span><b>${e(k)}</b> ${e(v ?? "unknown")}</span>`).join("");
  const card = `<div class="card"><div class="k">Verification run ${e(runId)}</div><h1><i style="background:${assessment.green ? STATUS.pass[0] : STATUS.fail[0]}"></i>${e(verdict)}</h1>` +
    `<p class="n">${e(`pass ${counts.pass} · fail ${counts.fail} · blocked ${counts.blocked} · unknown ${counts.unknown} · expected ${expectedTotal ?? "unknown"} · stored slots ${assessment.actualTotal}`)}</p>` +
    `<table><tr><th></th>${head}</tr>${body}</table><p class="f">${facts}</p>` +
    `<p class="x">Cells are stored slot outcomes; ! marks a slot named in a report problem. The verdict is re-assessed from stored evidence (scripts/verify/report.mjs loadRun).</p></div>`;
  const style = `<style>.card{box-sizing:border-box;width:1280px;padding:32px 40px;background:#1a1a19;color:#ffffff;font:15px/1.45 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif}` +
    `.k{color:#898781;font-size:13px}h1{margin:6px 0 4px;font-size:26px;font-weight:600}h1 i{width:14px;height:14px}.n{margin:0 0 20px;color:#c3c2b7}` +
    `table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #2c2c2a;padding:9px 10px;text-align:left;font-weight:500}th small{display:block;color:#898781;font-size:11px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}` +
    `th.m{font-family:Menlo,monospace;font-size:13px;color:#c3c2b7}td{font-size:13px;font-weight:600}i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;vertical-align:baseline}` +
    `.f{display:flex;flex-wrap:wrap;gap:6px 22px;margin:20px 0 6px;color:#c3c2b7;font-size:13px}.f b{color:#898781;font-weight:500}.x{margin:0;color:#898781;font-size:12px}</style>`;
  return PAGE("Verification results", "1280px", `${style}${card}${caption === null ? "" : `<div class="cap">${escapeHTML(caption)}</div>`}`);
}

// Spec: data only. Paths are run-relative (slots/<slot>/<file>); times are original recording milliseconds.
const LIMITS = Object.freeze({ segments: 40, stills: 12, fps: [1, 30], speed: [0.25, 32], outputMs: 300_000, frames: 9000, caption: 120 });
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, SLOT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}__[A-Z][A-Z0-9]{1,15}$/;
function exact(value, allowed, where) {
  if (!plain(value)) invalid(`${where} must be an object`);
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) invalid(`${where}: unknown field ${extra[0]}`);
}
const finiteMs = (v, where) => Number.isFinite(v) && v >= 0 && v <= 86_400_000 ? v : invalid(`${where} must be a time in milliseconds`);
const text = (v, where) => v === undefined ? null
  : typeof v === "string" && v.length <= LIMITS.caption && /^[^\p{Cc}\p{Cs}]*$/u.test(v) ? v : invalid(`${where} must be printable text of at most ${LIMITS.caption} characters`);
function source(entry, where) {
  if (typeof entry.slot !== "string" || !SLOT.test(entry.slot)) invalid(`${where}.slot must be a slot directory name such as <model>__V01`);
  if (typeof entry.recording !== "string" || !NAME.test(entry.recording) || entry.recording.endsWith(".")) invalid(`${where}.recording must be a file name inside the slot directory`);
  return { slot: entry.slot, recording: entry.recording, path: `slots/${entry.slot}/${entry.recording}` };
}
/** Validate and normalise a render spec; never touches the filesystem. */
export function parseSpec(raw) {
  exact(raw, ["run", "video", "stills"], "spec");
  if (typeof raw.run !== "string" || !raw.run.trim()) invalid("spec.run must name the saved run directory");
  if (raw.video === undefined && raw.stills === undefined) invalid("spec needs video and/or stills");
  let video = null, stills = [];
  if (raw.video !== undefined) {
    exact(raw.video, ["fps", "segments"], "video");
    const fps = raw.video.fps ?? 10;
    if (!Number.isInteger(fps) || fps < LIMITS.fps[0] || fps > LIMITS.fps[1]) invalid(`video.fps must be an integer ${LIMITS.fps.join("..")}`);
    const list = raw.video.segments;
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.segments) invalid(`video.segments must list 1..${LIMITS.segments} segments`);
    const segments = list.map((entry, i) => {
      const where = `video.segments[${i}]`;
      exact(entry, ["slot", "recording", "fromMs", "toMs", "speed", "caption"], where);
      const fromMs = finiteMs(entry.fromMs, `${where}.fromMs`), toMs = finiteMs(entry.toMs, `${where}.toMs`), speed = entry.speed ?? 1;
      if (!(toMs > fromMs)) invalid(`${where}: toMs must be greater than fromMs`);
      if (!Number.isFinite(speed) || speed < LIMITS.speed[0] || speed > LIMITS.speed[1]) invalid(`${where}.speed must be ${LIMITS.speed.join("..")}`);
      return { ...source(entry, where), fromMs, toMs, speed, caption: text(entry.caption, `${where}.caption`) };
    });
    const outputMs = segments.reduce((sum, s) => sum + (s.toMs - s.fromMs) / s.speed, 0);
    if (outputMs > LIMITS.outputMs) invalid(`video is ${Math.round(outputMs / 1000)} s after speed-up; the limit is ${LIMITS.outputMs / 1000} s`);
    video = { fps, segments };
  }
  if (raw.stills !== undefined) {
    if (!Array.isArray(raw.stills) || raw.stills.length > LIMITS.stills) invalid(`stills must list at most ${LIMITS.stills} stills`);
    stills = raw.stills.map((entry, i) => {
      const where = `stills[${i}]`;
      if (plain(entry) && entry.summary !== undefined) {
        exact(entry, ["summary", "caption", "name"], where);
        if (entry.summary !== true) invalid(`${where}.summary must be true`);
      } else exact(entry, ["slot", "recording", "atMs", "caption", "name"], where);
      if (entry.name !== undefined && (typeof entry.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(entry.name))) invalid(`${where}.name must be lowercase letters, digits and dashes`);
      const common = { name: entry.name ?? null, caption: text(entry.caption, `${where}.caption`) };
      return entry.summary ? { kind: "summary", ...common } : { kind: "still", ...source(entry, where), atMs: finiteMs(entry.atMs, `${where}.atMs`), ...common };
    });
  }
  if (!video && !stills.length) invalid("spec produces no output");
  return { run: raw.run, video, stills };
}

/** Frame times in original recording time; each segment keeps its first and last instant. */
export function planFrames(video) {
  const frames = [];
  let outputMs = 0;
  video.segments.forEach((segment, index) => {
    const span = segment.toMs - segment.fromMs, count = Math.max(1, Math.round(span / segment.speed / 1000 * video.fps));
    for (let k = 0; k < count; k++) frames.push({ segment: index, timeMs: count === 1 ? segment.fromMs : segment.fromMs + span * k / (count - 1),
      outputMs: round(outputMs + k * 1000 / video.fps) });
    outputMs += count * 1000 / video.fps;
  });
  if (frames.length > LIMITS.frames) invalid(`video needs ${frames.length} frames; the limit is ${LIMITS.frames}`);
  return frames;
}
/** Every edit between consecutive segments, in original time. */
export function describeCuts(segments) {
  return segments.slice(1).map((next, i) => {
    const prev = segments[i], same = prev.path === next.path;
    const kind = !same ? "recording-switch" : next.fromMs > prev.toMs ? "time-skip" : next.fromMs < prev.toMs ? "rewind" : "continuous";
    return { afterSegment: i, kind, from: { source: prev.path, ms: prev.toMs }, to: { source: next.path, ms: next.fromMs },
      ...(kind === "time-skip" ? { omittedMs: round(next.fromMs - prev.toMs) } : {}) };
  });
}
export const clock = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const speedText = v => `x${Number.isInteger(v) ? v : round(v)}`;
export function captionFor({ model, scenario, phase, timeMs, speed = null, note = null, still = false }) {
  return [still ? "Still from a real PTY recording" : "Edited replay of a real PTY recording",
    `${model} ${scenario}${phase ? `/${phase}` : ""}`, `original t=${clock(timeMs)}`, speed === null ? null : `speed ${speedText(speed)}`, note]
    .filter(Boolean).join(" · ");
}

const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); };
/** Real path of the parent, resolving symlinks and on-disk letter case (native realpath) through the deepest existing ancestor so containment checks cannot be bypassed. */
function realParent(target) {
  const rest = [path.basename(target)];
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    try { return path.join(fs.realpathSync.native(dir), ...rest); }
    catch (error) { if (error.code !== "ENOENT" || dir === path.dirname(dir)) throw error; rest.unshift(path.basename(dir)); }
  }
}
/** A new (or empty, real) directory outside .verify-runs and the source run; returns whether it was created. */
export function prepareOutputDir(out, { forbidden = [] } = {}) {
  if (typeof out !== "string" || !out.trim()) invalid("--out is required");
  const target = realParent(path.resolve(out));
  for (const root of forbidden.filter(Boolean)) {
    let real = path.resolve(root);
    try { real = fs.realpathSync.native(real); } catch {}
    if (inside(target, real)) invalid(`Refusing output inside ${root}`);
  }
  let stat = null;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!stat) {
    if (!fs.existsSync(path.dirname(target))) invalid(`Output parent directory does not exist: ${path.dirname(out)}`);
    fs.mkdirSync(target, { mode: 0o755 });
    return { dir: target, created: true };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid(`Refusing output path that is not a directory: ${out}`);
  if (fs.readdirSync(target).length) invalid(`Refusing non-empty output directory: ${out}`);
  return { dir: target, created: false };
}

/** Resolve a run-relative path without following any symlink component. */
function runFile(dir, relative) {
  let current = dir;
  const parts = relative.split("/");
  parts.forEach((part, i) => {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) invalid(`Refusing non-regular run path: ${relative}`);
  });
  return current;
}
/** Sources must be sealed run artifacts: the hash chain is summary.json -> artifact-manifest.json -> recording. */
function sealedArtifacts(run) {
  const ref = run.summary.artifacts?.manifest;
  if (!plain(ref) || ref.path !== "artifact-manifest.json" || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")) invalid("The run has no sealed artifact manifest; only finished runs can be rendered");
  const bytes = fs.readFileSync(runFile(run.dir, ref.path));
  if (sha(bytes) !== ref.sha256) invalid("artifact-manifest.json does not match the hash in summary.json");
  const entries = JSON.parse(bytes).entries;
  if (!Array.isArray(entries)) invalid("artifact-manifest.json has no entries");
  return new Map(entries.filter(e => e?.kind === "file" && typeof e.path === "string").map(e => [e.path, e.sha256]));
}
function loadSource(run, sealed, relative) {
  const expected = sealed.get(relative);
  if (!expected) invalid(`${relative} is not a sealed artifact of this run`);
  const file = runFile(run.dir, relative), bytes = fs.readFileSync(file);
  if (sha(bytes) !== expected) invalid(`${relative} differs from its sealed SHA256`);
  const recording = readRecording(file);
  return { path: relative, sha256: expected, bytes: bytes.length, recording, phases: recording.frames.filter(f => f.type === "phase"),
    endMs: recording.footer.timeMs, launch: recording.header.launch, capture: { complete: recording.footer.complete, truncated: recording.footer.truncated, error: recording.footer.error } };
}
/** Everything that can be checked before any output exists: slots, sealed sources and time ranges. */
export function resolveSources(spec, run) {
  const sealed = sealedArtifacts(run), sources = new Map(), slots = new Map();
  for (const item of [...(spec.video?.segments ?? []), ...spec.stills.filter(s => s.kind === "still")]) {
    if (!slots.has(item.slot)) {
      const slot = run.slots.find(s => typeof s?.model === "string" && `${s.model}__${s.scenario}` === item.slot);
      if (!slot) invalid(`${item.slot} is not a slot of this run`);
      slots.set(item.slot, { model: slot.model, scenario: slot.scenario, outcome: slot.outcome });
    }
    if (!sources.has(item.path)) sources.set(item.path, loadSource(run, sealed, item.path));
    const { endMs } = sources.get(item.path), last = item.toMs ?? item.atMs;
    if (last > endMs) invalid(`${item.path}: ${last} ms is after the recording ends (${round(endMs)} ms)`);
  }
  return { sources, slots };
}

export function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error("Rasterizer did not return a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const packageVersion = name => { try { return require(`${name}/package.json`).version; } catch { return null; } };
/** System Chrome, fresh temporary profile, JavaScript off, every request aborted; one page reused for every frame. */
export async function chromeRasterizer({ timeoutMs = 30_000, chromium } = {}) {
  chromium ??= (await import("playwright-core")).chromium;
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: timeoutMs,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync"] });
  try {
    const context = await withTimeout(browser.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1, javaScriptEnabled: false,
      offline: true, serviceWorkers: "block", acceptDownloads: false }), timeoutMs, "Chrome context");
    await withTimeout(context.route("**/*", route => route.abort()), timeoutMs, "Chrome route");
    const page = await withTimeout(context.newPage(), timeoutMs, "Chrome page");
    page.setDefaultTimeout(timeoutMs);
    return { chrome: browser.version(), playwright: packageVersion("playwright-core"),
      async render(html) {
        await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
        return page.locator("#frame").screenshot({ type: "png", animations: "disabled", caret: "hide", timeout: timeoutMs });
      },
      close: () => withTimeout(browser.close(), timeoutMs, "Chrome close") };
  } catch (error) { await withTimeout(browser.close(), timeoutMs, "Chrome close").catch(() => {}); throw error; }
}
const exec = (command, args, timeoutMs) => new Promise((resolve, reject) => execFile(command, args,
  { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 << 20, windowsHide: true }, (error, stdout, stderr) => error
    ? reject(new Error(`${command} failed${error.killed ? ` (timed out after ${timeoutMs} ms)` : ""}: ${String(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`))
    : resolve(String(stdout))));
const ENCODERS = [["libx264", "h264", ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "stillimage"]],
  ["h264_videotoolbox", "h264", ["-c:v", "h264_videotoolbox", "-b:v", "6M"]], ["mpeg4", "mpeg4", ["-c:v", "mpeg4", "-q:v", "2"]]];
/** ffmpeg + ffprobe with bounded runs; prefers libx264 and says so when it falls back. */
export async function ffmpegEncoder({ timeoutMs = 600_000, ffmpeg = "ffmpeg", ffprobe = "ffprobe", log = () => {} } = {}) {
  const version = (await exec(ffmpeg, ["-hide_banner", "-version"], 15_000)).split("\n")[0].trim();
  const probeVersion = (await exec(ffprobe, ["-hide_banner", "-version"], 15_000)).split("\n")[0].trim();
  const listed = await exec(ffmpeg, ["-hide_banner", "-encoders"], 15_000);
  const [encoder, codec, args] = ENCODERS.find(([name]) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(listed)) ?? invalid("ffmpeg has no libx264, h264_videotoolbox or mpeg4 encoder");
  if (encoder !== "libx264") log(`libx264 is not available in ${version}; falling back to ${encoder}`);
  return { version, probeVersion, encoder, codec,
    encode: ({ framesDir, fps, out }) => exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-framerate", String(fps),
      "-i", path.join(framesDir, "%06d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", ...args, "-pix_fmt", "yuv420p", "-r", String(fps),
      "-an", "-map_metadata", "-1", "-movflags", "+faststart", out], timeoutMs),
    async probe(file) {
      const json = JSON.parse(await exec(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
        "stream=codec_name,width,height,pix_fmt,nb_read_frames:format=duration,format_name", "-of", "json", file], 120_000));
      const s = json.streams?.[0] ?? {};
      return { codec: s.codec_name, width: s.width, height: s.height, pixFmt: s.pix_fmt, frames: Number(s.nb_read_frames), durationSec: Number(json.format?.duration), format: json.format?.format_name };
    } };
}

function screenHTML(snapshot, caption, rules, counts) {
  const redacted = redactSnapshot(snapshot, rules, counts).snapshot;
  return renderScreenHTML(redacted, { caption: redactText(caption, rules, counts).text });
}
async function replayAt(replays, source, ms) {
  let replay = replays.get(source.path);
  if (replay && replay.timeMs > ms) { replay.dispose(); replay = null; }
  if (!replay) replays.set(source.path, replay = createReplay(source.recording));
  await replay.advance(ms);
  return replay;
}
const sourceRecord = s => ({ path: s.path, sha256: s.sha256, bytes: s.bytes, launch: s.launch, endMs: round(s.endMs), capture: s.capture });

/** Render every output of a validated spec. Rasterizer/encoder are injected so the pipeline is testable offline. */
export async function renderMedia({ spec, run, out, rasterizer, encoder = null, rules = redactionRules(), tmpRoot = os.tmpdir(), log = () => {} }) {
  const { sources, slots } = resolveSources(spec, run), outputs = [], replays = new Map(), created = [];
  const writeNew = (name, bytes) => { const file = path.join(out, name); fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o644 }); created.push(file); return file; };
  const described = (name, bytes) => ({ file: name, bytes: bytes.length, sha256: sha(bytes) });
  let framesDir = null;
  try {
    for (const [i, still] of spec.stills.entries()) {
      const name = `still-${String(i + 1).padStart(2, "0")}${still.name ? `-${still.name}` : ""}.png`, counts = zeroCounts(rules);
      let html, record;
      if (still.kind === "summary") {
        html = renderSummaryHTML(run, { caption: ["Rendered from the saved run's stored evidence, not a screen recording", still.caption && redactText(still.caption, rules, counts).text].filter(Boolean).join(" · ") });
        const assessment = assessRun(run.summary, run.slots, { integrityProblems: run.integrityProblems });
        record = { kind: "summary", green: assessment.green, counts: assessment.counts, expectedTotal: assessment.expectedTotal, problems: assessment.problems.length, redactions: counts };
      } else {
        const source = sources.get(still.path), slot = slots.get(still.slot), replay = await replayAt(replays, source, still.atMs), phase = phaseAt(source.phases, still.atMs);
        html = screenHTML(replay.snapshot(), captionFor({ ...slot, phase, timeMs: still.atMs, note: still.caption, still: true }), rules, counts);
        record = { kind: "still", slot: still.slot, model: slot.model, scenario: slot.scenario, slotOutcome: slot.outcome, phase, atMs: round(still.atMs), source: sourceRecord(source), redactions: counts };
      }
      const png = await rasterizer.render(html);
      writeNew(name, png);
      outputs.push({ ...described(name, png), ...pngSize(png), ...record });
      log(`wrote ${name}`);
    }
    if (spec.video) {
      const { fps, segments } = spec.video, frames = planFrames(spec.video), counts = zeroCounts(rules);
      framesDir = fs.mkdtempSync(path.join(tmpRoot, "ghcp-render-"));
      let previous = null, size = null, unique = 0;
      for (const [i, frame] of frames.entries()) {
        const segment = segments[frame.segment], source = sources.get(segment.path), slot = slots.get(segment.slot);
        const replay = await replayAt(replays, source, frame.timeMs);
        const caption = captionFor({ ...slot, phase: phaseAt(source.phases, frame.timeMs), timeMs: frame.timeMs, speed: segment.speed, note: segment.caption });
        const html = screenHTML(replay.snapshot(), caption, rules, counts), file = path.join(framesDir, `${String(i + 1).padStart(6, "0")}.png`);
        if (html === previous?.html) { fs.linkSync(previous.file, file); continue; }
        const png = await rasterizer.render(html), dims = pngSize(png);
        if (size && (dims.width !== size.width || dims.height !== size.height)) throw new Error(`Video frame ${i + 1} is ${dims.width}x${dims.height}, expected ${size.width}x${size.height}`);
        size ??= dims;
        fs.writeFileSync(file, png, { flag: "wx", mode: 0o600 });
        previous = { html, file };
        unique++;
        if (unique % 100 === 0) log(`rasterized ${unique} unique frames (${i + 1}/${frames.length})`);
      }
      const name = "video.mp4", file = path.join(out, name);
      created.push(file);
      await encoder.encode({ framesDir, fps, out: file });
      const probe = await encoder.probe(file), width = size.width + size.width % 2, height = size.height + size.height % 2;
      const durationOk = Math.abs(probe.durationSec - frames.length / fps) <= 1 / fps + 0.05;
      if (probe.codec !== encoder.codec || probe.pixFmt !== "yuv420p" || probe.frames !== frames.length || probe.width !== width || probe.height !== height || !durationOk) {
        throw new Error(`ffprobe rejected ${name}: ${JSON.stringify(probe)}; expected ${encoder.codec} yuv420p ${width}x${height}, ${frames.length} frames at ${fps} fps`);
      }
      const bytes = fs.readFileSync(file);
      let outputMs = 0;
      outputs.push({ ...described(name, bytes), kind: "video", label: VIDEO_TITLE, fps, frames: frames.length, uniqueFrames: unique, durationMs: round(frames.length * 1000 / fps),
        width, height, encoder: encoder.encoder, probe, redactions: counts, redactionCounting: "replacements summed over every video frame",
        segments: segments.map((s, index) => {
          const count = frames.filter(f => f.segment === index).length, slot = slots.get(s.slot), outputFromMs = round(outputMs);
          outputMs += count * 1000 / fps;
          return { index, slot: s.slot, model: slot.model, scenario: slot.scenario, slotOutcome: slot.outcome, phases: phasesIn(sources.get(s.path).phases, s.fromMs, s.toMs),
            source: sourceRecord(sources.get(s.path)), original: { fromMs: round(s.fromMs), toMs: round(s.toMs) }, speed: s.speed, frames: count,
            output: { fromMs: outputFromMs, toMs: round(outputMs) }, caption: s.caption === null ? null : redactText(s.caption, rules).text };
        }), cuts: describeCuts(segments) });
      log(`wrote ${name} (${frames.length} frames, ${unique} unique, ${encoder.encoder})`);
    }
    const totals = zeroCounts(rules);
    for (const output of outputs) for (const [id, n] of Object.entries(output.redactions ?? {})) totals[id] += n;
    const assessment = assessRun(run.summary, run.slots, { integrityProblems: run.integrityProblems });
    const manifest = { schema: "ghcp-render-manifest", version: 1, label: VIDEO_TITLE,
      notice: "Stills and video are edited replays of output-only PTY recordings sealed in the run's artifact manifest; the results card is rendered from stored evidence. Neither is verification evidence.",
      run: { id: path.basename(run.dir), green: assessment.green, counts: assessment.counts, expectedTotal: assessment.expectedTotal, problems: assessment.problems.length },
      tools: { node: process.version, xtermHeadless: packageVersion("@xterm/headless"), playwrightCore: rasterizer.playwright ?? null, chrome: rasterizer.chrome ?? null,
        ffmpeg: encoder?.version ?? null, ffprobe: encoder?.probeVersion ?? null, encoder: encoder?.encoder ?? null },
      redaction: { rules: rules.map(({ id, label, description }) => ({ id, placeholder: label, description, count: totals[id] })), note: "Counts only; redacted values are never stored." },
      outputs };
    writeNew("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    for (const file of created.reverse()) fs.rmSync(file, { force: true });
    throw error;
  } finally {
    for (const replay of replays.values()) replay.dispose();
    if (framesDir) fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

export function parseRenderArgs(argv) {
  const options = { spec: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (flag !== "--spec" && flag !== "--out") invalid(`Unknown argument: ${argv[i]}\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (!value || value.startsWith("--")) invalid(`${flag} needs a value\n${USAGE}`);
    options[flag.slice(2)] = value;
  }
  if (!options.help && (!options.spec || !options.out)) invalid(USAGE);
  return options;
}
export function readSpec(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 256 * 1024) invalid("--spec must be a regular JSON file of at most 256 KiB");
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { invalid("--spec is not valid JSON"); }
  return parseSpec(raw);
}
/** Validate everything first; create the output directory only when rendering can start. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? (message => process.stderr.write(`${message}\n`)), options = parseRenderArgs(argv);
  if (options.help) { log(USAGE); return null; }
  const specFile = path.resolve(options.spec), spec = readSpec(specFile);
  const loadRun = deps.loadRun ?? (await import("./report.mjs")).loadRun;
  const run = loadRun(path.resolve(path.dirname(specFile), spec.run));
  resolveSources(spec, run);
  const target = prepareOutputDir(options.out, { forbidden: [path.join(deps.rootDir ?? ROOT, ".verify-runs"), run.dir] });
  let rasterizer = null;
  try {
    rasterizer = await (deps.createRasterizer ?? chromeRasterizer)();
    const encoder = spec.video ? await (deps.createEncoder ?? ffmpegEncoder)({ log }) : null;
    const manifest = await renderMedia({ spec, run, out: target.dir, rasterizer, encoder, rules: deps.rules ?? redactionRules(), tmpRoot: deps.tmpRoot, log });
    log(`manifest: ${path.join(target.dir, "manifest.json")}`);
    return manifest;
  } catch (error) {
    if (target.created) fs.rmSync(target.dir, { recursive: true, force: true });
    throw error;
  } finally { try { await rasterizer?.close(); } catch (error) { log(`browser close failed: ${error.message}`); } }
}
/** A Chrome that ignored close keeps its pipes open; after the grace period process.exit runs Playwright's exit hook, which SIGKILLs it. */
export const cli = (argv, deps, graceMs = 2000) => main(argv, deps).then(() => {}, error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), graceMs).unref());
if (isEntryPoint(import.meta.url)) cli();

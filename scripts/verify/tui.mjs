/**
 * Real Claude Code TUI sessions for the verification harness.
 *
 * The interactive terminal is the product people use, so it is the only
 * surface the harness drives. Each session is the real `claude` binary in a
 * private PTY (terminal-pty.py), rendered by a headless xterm so the harness
 * sees what a person would see, and driven by keystrokes: prompts are pasted
 * into the input box and submitted with Enter, slash commands are typed, Esc
 * interrupts.
 *
 * The screen is for readiness and for the record. Verdicts come from what
 * Claude Code itself persists -- the session transcript and the payloads of
 * hooks the harness registers -- and from the bridge's own log. Rendered text
 * is never parsed for an answer: wrapping, spinners and markdown rendering
 * make it a lossy copy of what the transcript already holds verbatim.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { sanitizeEnv } from "./session.mjs";
import { seedConfigDir } from "./bridge.mjs";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const PTY_HELPER = fileURLToPath(new URL("./terminal-pty.py", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The footer under the input box names the permission mode in words. Hook
// payloads name it too, but only once the next prompt has already gone.
const PERMISSION_FOOTERS = Object.freeze({
  bypassPermissions: /bypass permissions on/,
  auto: /auto mode on/,
  acceptEdits: /accept edits on/,
  plan: /plan mode on/,
  default: /manual mode on/,
});

export const KEYS = Object.freeze({
  enter: "\r",
  escape: "\x1b",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
  ctrlC: "\x03",
});

/**
 * Hook events the harness records for every session.
 *
 * Stop and StopFailure are how a turn's end is detected: the TUI has no
 * result event, and a spinner disappearing is not evidence of anything.
 * The rest are evidence in their own right -- compaction, subagent handoff,
 * the session starting and ending.
 */
export const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
]);

// Hooks inherit the TUI's environment, so one recorder serves every session
// and VERIFY_HOOK_LOG routes each launch's payloads to that launch's own file.
// Two TUIs sharing a config dir -- the concurrent-session scenario -- would
// otherwise interleave in one log with nothing to tell them apart before
// their session ids are known.
const RECORDER_SOURCE = `// Written by the verification harness. Appends each hook payload it is handed.
import fs from "node:fs";
const target = process.env.VERIFY_HOOK_LOG;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!target) return;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = { unparsed: input.slice(0, 2000) }; }
  fs.appendFileSync(target, JSON.stringify({ recordedAt: Date.now(), ...payload }) + "\\n");
});
`;

function realpathOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function mergeHooks(base, extra = {}) {
  const merged = { ...base };
  for (const [event, groups] of Object.entries(extra)) {
    merged[event] = [...(merged[event] ?? []), ...groups];
  }
  return merged;
}

/**
 * A config dir a TUI can start in without a person at the keyboard.
 *
 * The trust and bypass-permission dialogs are Claude Code's own first-run
 * surface, not the bridge's, so they are accepted here rather than clicked
 * through. `settings` is merged into the user settings file; its hooks join
 * the harness recorder's rather than replacing them.
 */
export function prepareTuiConfig(configDir, { version, workspaces = [], settings = {} } = {}) {
  seedConfigDir(configDir, { version });
  const statePath = path.join(configDir, ".claude.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 };
  state.projects = {};
  for (const dir of workspaces) {
    for (const key of new Set([dir, realpathOrSelf(dir)])) state.projects[key] = { ...trusted };
  }
  state.bypassPermissionsModeAccepted = true;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  const recorder = path.join(configDir, "verify-hook-recorder.mjs");
  fs.writeFileSync(recorder, RECORDER_SOURCE, "utf8");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)}`;
  const recorded = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command }] }]]),
  );
  const { hooks, ...rest } = settings;
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ skipDangerousModePermissionPrompt: true, ...rest, hooks: mergeHooks(recorded, hooks) }, null, 2),
    "utf8",
  );
  return { recorder };
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A line still being appended; the next read sees it whole.
    }
  }
  return rows;
}

// A fork's transcript does not exist until its first turn, and that turn
// writes the inherited conversation into the new file along with its own
// lines. The copies keep their original timestamps, so a line stamped before
// the prompt went in belongs to an earlier turn, whichever file it sits in.
// Bookkeeping lines carry no timestamp and no evidence either way.
function turnEntries(entries, startedAt) {
  return entries.filter((entry) => !entry.timestamp || Date.parse(entry.timestamp) >= startedAt);
}

const isInterruptMarker = (entry) =>
  entry.type === "user" && /\[Request interrupted by user/.test(blockText(entry.message?.content));

export class TuiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TuiError";
    Object.assign(this, details);
  }
}

/**
 * One launch of the real TUI: one process, one PTY, one hook log.
 *
 * A scenario that resumes, forks or restarts makes a new TuiSession over the
 * same config dir; the transcript Claude Code keeps there is what carries
 * the conversation across.
 */
export class TuiSession {
  constructor({
    claudeBin,
    cwd,
    configDir,
    args = [],
    env = process.env,
    extraEnv = {},
    artifactDir,
    label = "tui",
    rows = 45,
    columns = 140,
  }) {
    Object.assign(this, { claudeBin, cwd, configDir, args, env, extraEnv, artifactDir, label, rows, columns });
    fs.mkdirSync(artifactDir, { recursive: true });
    this.hookLogPath = path.join(artifactDir, `${label}.hooks.jsonl`);
    this.rawPath = path.join(artifactDir, `${label}.pty.raw`);
    this.term = new Terminal({ rows, cols: columns, allowProposedApi: true, scrollback: 20_000 });
    // Claude Code asks the terminal about itself (device attributes, cursor
    // position) and a real terminal answers on the same wire. The headless
    // xterm composes those answers; they have to reach the PTY to count.
    this.term.onData((data) => this.write(data));
    this.term.onBinary((data) => this.control({ type: "input", base64: Buffer.from(data, "binary").toString("base64") }));
    this.receipts = [];
    this.pendingWrites = 0;
    this.lastOutputAt = 0;
    this.bytes = 0;
    this.helper = null;
    this.helperExit = null;
    this.childExit = null;
    this.sessionId = null;
    this.transcriptPath = null;
    this.snapshots = 0;
  }

  childEnv() {
    const env = {
      ...sanitizeEnv(this.env),
      CLAUDE_CONFIG_DIR: this.configDir,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      DISABLE_AUTOUPDATER: "1",
      VERIFY_HOOK_LOG: this.hookLogPath,
      ...this.extraEnv,
    };
    // CI=1 switches Claude Code into non-interactive behaviour; a person's
    // terminal never carries it.
    delete env.CI;
    return env;
  }

  control(message) {
    if (this.helper && !this.helper.stdin.destroyed && !this.helper.stdin.writableEnded) {
      this.helper.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  write(text) {
    this.control({ type: "input", base64: Buffer.from(text, "utf8").toString("base64") });
  }

  get exited() {
    return Boolean(this.childExit || this.helperExit);
  }

  async launch({ readyTimeoutMs = 90_000 } = {}) {
    if (this.helper) throw new TuiError("This session was already launched.");
    fs.writeFileSync(this.hookLogPath, "", { flag: "a" });
    this.raw = fs.openSync(this.rawPath, "a", 0o600);
    this.launchedAt = Date.now();
    const helper = spawn("python3", [PTY_HELPER], {
      cwd: this.cwd,
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.helper = helper;
    helper.stdin.on("error", () => {});
    this.helperStderr = "";
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      this.helperStderr = (this.helperStderr + chunk).slice(-20_000);
    });
    this.closed = new Promise((resolve) => {
      helper.once("close", (code, signal) => {
        this.helperExit = { code, signal };
        try { fs.closeSync(this.raw); } catch {}
        resolve();
      });
    });
    let buffer = "";
    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "data") {
          const bytes = Buffer.from(message.base64, "base64");
          try { fs.writeSync(this.raw, bytes); } catch {}
          this.bytes += bytes.length;
          this.lastOutputAt = Date.now();
          this.pendingWrites += 1;
          this.term.write(bytes, () => { this.pendingWrites -= 1; });
        } else {
          this.receipts.push(message);
          if (message.type === "child-exit") this.childExit = message;
        }
      }
    });
    this.control({
      bin: this.claudeBin,
      args: this.args,
      cwd: this.cwd,
      rows: this.rows,
      columns: this.columns,
      stopGraceMs: 5000,
    });

    const ready = await this.waitFor(
      () => this.hookEvents("SessionStart").at(-1) && this.inputReady(),
      readyTimeoutMs,
    );
    if (!ready) {
      this.snapshot("launch-failed");
      throw new TuiError(
        this.exited
          ? `Claude Code exited before its TUI was ready (${JSON.stringify(this.childExit ?? this.helperExit)}).`
          : `Claude Code's TUI was not ready within ${readyTimeoutMs}ms.`,
        { screen: this.screen(), helperStderr: this.helperStderr },
      );
    }
    const start = this.hookEvents("SessionStart").at(-1);
    this.sessionId = start.session_id ?? null;
    this.transcriptPath = start.transcript_path ?? null;
    await this.settle();
    this.snapshot("ready");
    return this;
  }

  /**
   * The input box is drawn and focused: a prompt line between the last two
   * horizontal rules. Earlier prompts in the scrollback and the cursor of a
   * selection dialog also start with the glyph, so neither counts.
   */
  inputReady() {
    const lines = this.screen().split("\n");
    const rules = lines.flatMap((line, index) => (/^─{20,}\s*$/.test(line) ? [index] : []));
    if (rules.length < 2) return false;
    const [top, bottom] = rules.slice(-2);
    return bottom - top >= 2 && /^❯/.test(lines[top + 1]);
  }

  /** The permission mode the footer names, or null while something else holds the screen. */
  permissionMode() {
    const footer = this.screen().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
    return Object.entries(PERMISSION_FOOTERS).find(([, pattern]) => pattern.test(footer))?.[0] ?? null;
  }

  /**
   * Press Shift+Tab until the footer names `mode`.
   *
   * The cycle is not fixed. It skips auto mode for a model that does not offer
   * it and bypass when bypass was not enabled at launch, so a press count that
   * is right for one model lands in the wrong mode for the next: four presses
   * reached plan mode on Sonnet and came back round to bypass on Haiku.
   */
  async setPermissionMode(mode, { maxPresses = 8 } = {}) {
    if (!PERMISSION_FOOTERS[mode]) throw new TuiError(`Unknown permission mode ${mode}.`);
    await this.#requireInput(`switch to ${mode}`);
    const seen = [];
    for (let presses = 0; presses <= maxPresses; presses += 1) {
      const current = this.permissionMode();
      seen.push(current);
      if (current === mode) return { mode, presses, seen };
      await this.press("shiftTab");
    }
    this.snapshot(`mode-${mode}-unreached`);
    throw new TuiError(`Shift+Tab never reached ${mode}; the footer went ${seen.join(" -> ")}.`, {
      screen: this.screen(),
    });
  }

  async flush() {
    if (this.pendingWrites > 0) await new Promise((resolve) => this.term.write("", resolve));
  }

  /**
   * Wait until the terminal has been quiet for `quietMs` since `from`, at
   * most `maxMs`.
   *
   * Quiet is measured from the input that prompted the wait as well as from
   * the last output: a terminal that was idle before a keypress has not
   * answered the keypress yet, however long it has been silent.
   */
  async settle({ quietMs = 400, maxMs = 5000, from = Date.now() } = {}) {
    const deadline = from + maxMs;
    while (Date.now() < deadline && Date.now() - Math.max(this.lastOutputAt, from) < quietMs) await sleep(50);
    await this.flush();
  }

  /** Poll `predicate` until it returns something truthy; null on timeout or exit. */
  async waitFor(predicate, timeoutMs, { pollMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.flush();
      const value = predicate();
      if (value) return value;
      if (this.exited || Date.now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  /** The visible viewport, as text. */
  screen() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y += 1) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  /** Everything the terminal still holds, scrollback included. */
  history() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  snapshot(name) {
    this.snapshots += 1;
    const file = path.join(this.artifactDir, `${this.label}.${String(this.snapshots).padStart(2, "0")}-${name}.screen.txt`);
    try { fs.writeFileSync(file, this.screen(), "utf8"); } catch {}
    return file;
  }

  hookEvents(name) {
    const rows = readJsonl(this.hookLogPath);
    return name ? rows.filter((row) => row.hook_event_name === name) : rows;
  }

  transcriptEntries(file = this.transcriptPath) {
    return file ? readJsonl(file) : [];
  }

  /** Paste as a terminal does, so a multi-line prompt stays one prompt. */
  async paste(text) {
    const from = Date.now();
    this.write(`\x1b[200~${text}\x1b[201~`);
    await this.settle({ quietMs: 300, maxMs: 3000, from });
  }

  /** Type keystrokes one write at a time, the way slash-command menus expect. */
  async type(text) {
    for (const char of text) {
      this.write(char);
      await sleep(15);
    }
    await this.settle({ quietMs: 250, maxMs: 2000 });
  }

  async press(key, { settle = true } = {}) {
    const from = Date.now();
    this.write(KEYS[key] ?? key);
    if (settle) await this.settle({ quietMs: 300, maxMs: 3000, from });
  }

  /** Wait for the input box, or fail naming what holds the screen instead. */
  async #requireInput(what, timeoutMs = 15_000) {
    if (await this.waitFor(() => this.inputReady(), timeoutMs)) return;
    this.snapshot("input-unavailable");
    throw new TuiError(`The input box was not available to ${what}; the screen is held by something else.`, {
      screen: this.screen(),
      helperStderr: this.helperStderr,
    });
  }

  /**
   * Submit one prompt and wait for the turn to end.
   *
   * The end of a turn is the Stop hook (or StopFailure, when the turn died on
   * an API error). Everything the turn appended to the transcript comes back
   * with it, so a driver judges exactly this turn and nothing before it.
   */
  async submit(text, { answers = [], timeoutMs = 240_000, name = "turn" } = {}) {
    const hooksBefore = this.hookEvents().length;
    const entriesBefore = this.transcriptEntries().length;
    const startedAt = Date.now();
    await this.#requireInput(`submit ${JSON.stringify(text.slice(0, 60))}`);
    await this.paste(text);
    this.write(KEYS.enter);
    const { end, answered } = await this.#awaitEnd({
      name,
      answers,
      timeoutMs,
      until: () => this.hookEvents().slice(hooksBefore).find((event) =>
        event.hook_event_name === "Stop" || event.hook_event_name === "StopFailure"),
    });
    const turn = await this.#finishTurn({ text, name, startedAt, end, hooksBefore, entriesBefore });
    return { ...turn, answered };
  }

  /**
   * Run a slash command and wait until `until(newHookEvents, newEntries)` holds.
   *
   * Commands do not all end in a Stop hook -- /compact ends in PostCompact,
   * /model in nothing at all -- so the caller names what completion means.
   */
  async command(text, { until, answers = [], timeoutMs = 120_000, name = "command" }) {
    const hooksBefore = this.hookEvents().length;
    const entriesBefore = this.transcriptEntries().length;
    const startedAt = Date.now();
    await this.#requireInput(`run ${text.split(" ")[0]}`);
    await this.type(text);
    this.write(KEYS.enter);
    const { end, answered } = await this.#awaitEnd({
      name,
      answers,
      timeoutMs,
      until: () => until(
        this.hookEvents().slice(hooksBefore),
        turnEntries(this.transcriptEntries().slice(entriesBefore), startedAt),
        this,
      ),
    });
    const turn = await this.#finishTurn({ text, name, startedAt, end: end ? { hook_event_name: "command", value: end } : null, hooksBefore, entriesBefore });
    return { ...turn, answered };
  }

  /**
   * Submit a prompt, wait until `when(newEntries)` holds, then press Esc.
   *
   * An interrupted turn fires no Stop hook. It is over once Claude Code has
   * written its "[Request interrupted by user" marker and handed the input
   * box back.
   */
  async interrupt(text, { when, timeoutMs = 120_000, name = "interrupt" }) {
    const hooksBefore = this.hookEvents().length;
    const entriesBefore = this.transcriptEntries().length;
    const startedAt = Date.now();
    const fresh = () => turnEntries(this.transcriptEntries().slice(entriesBefore), startedAt);
    await this.#requireInput(`submit ${JSON.stringify(text.slice(0, 60))}`);
    await this.paste(text);
    this.write(KEYS.enter);
    const reached = await this.waitFor(() => when(fresh()), timeoutMs);
    let end = null;
    if (reached) {
      this.snapshot(`${name}-before-esc`);
      await this.press("escape");
      end = await this.waitFor(
        () => fresh().some(isInterruptMarker) && this.inputReady() ? { hook_event_name: "interrupt" } : null,
        30_000,
      );
    }
    const turn = await this.#finishTurn({ text, name, startedAt, end, hooksBefore, entriesBefore });
    return { ...turn, reachedInterruptPoint: Boolean(reached) };
  }

  /**
   * Poll until `until()` holds. Some turns stop to ask first; each `answers`
   * entry is a screen pattern and the keys a person would press when it shows,
   * pressed once.
   */
  async #awaitEnd({ until, answers, timeoutMs, name }) {
    const pending = [...answers];
    const answered = [];
    const end = await this.waitFor(() => {
      const done = until();
      if (done) return done;
      const screen = this.screen();
      const index = pending.findIndex((answer) => answer.when.test(screen));
      if (index >= 0) {
        const [answer] = pending.splice(index, 1);
        this.snapshot(`${name}-asked`);
        answered.push(String(answer.when));
        this.write(KEYS[answer.keys] ?? answer.keys);
      }
      return null;
    }, timeoutMs);
    return { end, answered };
  }

  /**
   * Switch the session's model with /model, accepting the cache warning
   * Claude Code shows mid-conversation. Done when the command's own output
   * lands in the transcript; `said` is that output, for the served-model
   * check to compare against.
   */
  async switchModel(model, { timeoutMs = 60_000, name = "model" } = {}) {
    const turn = await this.command(`/model ${model}`, {
      name,
      timeoutMs,
      answers: [{ when: /Switch model\?/, keys: "enter" }],
      until: (_hooks, entries) => entries.map((entry) => blockText(entry.message?.content))
        .find((text) => /<local-command-stdout>/.test(text)),
    });
    const said = typeof turn.hook?.value === "string"
      ? turn.hook.value.replace(/<\/?local-command-stdout>/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim()
      : null;
    return { ...turn, said };
  }

  async #finishTurn({ text, name, startedAt, end, hooksBefore, entriesBefore }) {
    // The Stop hook runs once the turn's messages are written, but the
    // bookkeeping lines after them land a moment later.
    await sleep(500);
    await this.settle({ quietMs: 300, maxMs: 3000 });
    const outcome = !end ? (this.exited ? "exited" : "timeout")
      : end.hook_event_name === "StopFailure" ? "stop_failure"
      : end.hook_event_name === "interrupt" ? "interrupted"
      : "stop";
    this.snapshot(name);
    return {
      name,
      prompt: text,
      outcome,
      hook: end ?? null,
      durationMs: Date.now() - startedAt,
      hooks: this.hookEvents().slice(hooksBefore),
      entries: turnEntries(this.transcriptEntries().slice(entriesBefore), startedAt),
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath,
      screen: this.screen(),
    };
  }

  /** End the TUI the way a person does, and reap everything it started. */
  async close({ timeoutMs = 15_000 } = {}) {
    if (!this.helper) return null;
    if (!this.helperExit) {
      this.control({ type: "stop" });
      await Promise.race([this.closed, sleep(timeoutMs)]);
      if (!this.helperExit) {
        try { this.helper.kill("SIGKILL"); } catch {}
        await this.closed;
      }
    }
    try {
      fs.writeFileSync(path.join(this.artifactDir, `${this.label}.history.txt`), this.history(), "utf8");
    } catch {}
    const cleanup = this.receipts.findLast((receipt) => receipt.type === "cleanup") ?? null;
    return {
      childExit: this.childExit,
      helperExit: this.helperExit,
      cleanup,
      processGroupGone: cleanup?.processGroupGone === true,
      sessionEnded: this.hookEvents("SessionEnd").length > 0,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Transcript reading
 * ------------------------------------------------------------------ */

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Evidence from the lines one turn appended to Claude Code's transcript.
 *
 * Claude Code writes one transcript entry per content block and repeats the
 * message id across them, so API messages are regrouped by id before stop
 * reasons or usage are read. Subagent work lives in separate sidechain files
 * and is never mistaken for this session's own answer.
 */
export class TranscriptRun {
  constructor(entries, meta = {}) {
    this.entries = entries;
    Object.assign(this, meta);
  }

  get assistantEntries() {
    return this.entries.filter((entry) => entry.type === "assistant" && !entry.isSidechain);
  }

  /** API messages in order, each with its blocks, final stop reason and usage. */
  get messages() {
    const byId = new Map();
    for (const entry of this.assistantEntries) {
      const message = entry.message ?? {};
      const id = message.id ?? entry.uuid;
      let record = byId.get(id);
      if (!record) {
        record = { id, model: message.model ?? null, stopReason: null, usage: null, blocks: [], apiError: entry.isApiErrorMessage === true };
        byId.set(id, record);
      }
      record.blocks.push(...(Array.isArray(message.content) ? message.content : []));
      if (message.stop_reason) record.stopReason = message.stop_reason;
      if (message.usage) record.usage = message.usage;
      if (entry.isApiErrorMessage) record.apiError = true;
    }
    return [...byId.values()];
  }

  get modelMessages() {
    return this.messages.filter((message) => !message.apiError);
  }

  get apiErrors() {
    return this.messages.filter((message) => message.apiError).map((message) =>
      message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
  }

  get mainBlocks() {
    return this.modelMessages.flatMap((message) => message.blocks);
  }

  get text() {
    return this.mainBlocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }

  /** What the session finally said: its prose after its last tool call. */
  get answer() {
    const blocks = this.mainBlocks;
    const lastCall = blocks.map((block) => block.type).lastIndexOf("tool_use");
    return blocks
      .slice(lastCall + 1)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  get thinkingBlocks() {
    return this.mainBlocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
  }

  get toolUses() {
    return this.mainBlocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input ?? {} }));
  }

  get toolResults() {
    return this.entries
      .filter((entry) => entry.type === "user" && !entry.isSidechain && Array.isArray(entry.message?.content))
      .flatMap((entry) => entry.message.content
        .filter((block) => block?.type === "tool_result")
        .map((block) => ({
          id: block.tool_use_id,
          isError: block.is_error === true,
          content: blockText(block.content),
          blocks: Array.isArray(block.content) ? block.content : [],
          structured: entry.toolUseResult ?? null,
        })));
  }

  /** The prompts a person typed this turn, as Claude Code recorded them. */
  get userPrompts() {
    return this.entries
      .filter((entry) => entry.type === "user" && !entry.isSidechain && !entry.isMeta)
      .map((entry) => entry.message?.content)
      .filter((content) => typeof content === "string" || (Array.isArray(content) && !content.some((block) => block?.type === "tool_result")))
      .map(blockText);
  }

  get interrupted() {
    return this.entries.some((entry) => entry.type === "user" && /\[Request interrupted by user/.test(blockText(entry.message?.content)));
  }

  get compactBoundaries() {
    return this.entries.filter((entry) => entry.type === "system" && entry.subtype === "compact_boundary");
  }

  toolNames() {
    return [...new Set(this.toolUses.map((use) => use.name))];
  }

  usedTool(...names) {
    const wanted = names.map((name) => name.toLowerCase());
    return this.toolUses.some((use) => wanted.includes(String(use.name).toLowerCase()));
  }

  usesOf(name) {
    const wanted = String(name).toLowerCase();
    return this.toolUses.filter((use) => String(use.name).toLowerCase() === wanted);
  }

  usedToolMatching(pattern) {
    return this.toolUses.some((use) => pattern.test(String(use.name)));
  }

  /** Messages that asked for more than one tool before any result came back. */
  parallelBatches() {
    return this.modelMessages
      .map((message) => message.blocks.filter((block) => block.type === "tool_use").map((block) => block.name))
      .filter((names) => names.length > 1);
  }

  /** Every tool_use must be answered exactly once. A gap is a wire-level bug. */
  pairingReport() {
    const uses = this.toolUses;
    const results = this.toolResults;
    const resultIds = new Set(results.map((result) => result.id));
    const unanswered = uses.filter((use) => !resultIds.has(use.id)).map((use) => use.name);
    const useIds = new Set(uses.map((use) => use.id));
    const orphaned = results.filter((result) => !useIds.has(result.id)).map((result) => result.id);
    return { uses: uses.length, results: results.length, unanswered, orphaned, ok: unanswered.length === 0 && orphaned.length === 0 };
  }

  /** The largest prompt any one call of this turn carried, cache included. */
  get inputTokens() {
    return Math.max(0, ...this.modelMessages.map(({ usage }) =>
      (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)));
  }

  get models() {
    return [...new Set(this.modelMessages.map((message) => message.model).filter(Boolean))];
  }

  get finalStopReason() {
    return this.modelMessages.at(-1)?.stopReason ?? null;
  }

  get completed() {
    return this.outcome === "stop";
  }

  get timedOut() {
    return this.outcome === "timeout";
  }

  get failureHint() {
    if (this.outcome === "timeout") return `turn did not end within ${Math.round((this.durationMs ?? 0) / 1000)}s`;
    if (this.outcome === "exited") return "Claude Code exited mid-turn";
    if (this.outcome === "stop_failure") return `turn ended on an API error: ${this.apiErrors.join(" | ").slice(0, 200) || "StopFailure"}`;
    if (this.outcome === "launch_failed") return this.launchError ?? "the TUI never became ready";
    if (this.apiErrors.length) return `API error in turn: ${this.apiErrors.join(" | ").slice(0, 200)}`;
    return null;
  }
}

/** Wrap a finished turn from TuiSession.submit/command as judgeable evidence. */
export function turnRun(turn, extra = {}) {
  return new TranscriptRun(turn.entries, {
    outcome: turn.outcome,
    durationMs: turn.durationMs,
    sessionId: turn.sessionId,
    transcriptPath: turn.transcriptPath,
    hooks: turn.hooks,
    stopHook: turn.hook,
    prompt: turn.prompt,
    ...extra,
  });
}

/** Sidechain transcripts Claude Code keeps for the subagents of one session. */
export function subagentTranscripts(transcriptPath) {
  if (!transcriptPath) return [];
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ file: path.join(dir, name), entries: readJsonl(path.join(dir, name)) }));
}

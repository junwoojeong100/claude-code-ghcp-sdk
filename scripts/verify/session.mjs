/** Bounded print-mode CLI processes and ordered root stream-json evidence. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { cleanVerificationEnv } from "./bridge.mjs";

export function sanitizeEnv(env = process.env) {
  const clean = cleanVerificationEnv(env);
  // A nested node --test otherwise inherits its parent's binary IPC reporter.
  // NODE_OPTIONS can also inject code or change the independent test command.
  delete clean.NODE_TEST_CONTEXT;
  delete clean.NODE_OPTIONS;
  return clean;
}

// Confirmed against the installed CLI's --help. --bare disables auto-memory,
// hooks, CLAUDE.md discovery, plugin sync and background prefetches; empty
// setting sources and strict empty MCP prevent external configuration loading.
export const ISOLATION_ARGS = Object.freeze([
  "--bare", "--disable-slash-commands", "--include-hook-events", "--setting-sources", "",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome",
]);

export function runHeadless({ prompt, cwd, settingsPath, frontendModel, configDir,
  claudeBin, timeoutSeconds, extraArgs = [], transcriptPath, env = process.env,
  isolationArgs = ISOLATION_ARGS, childEnv = {}, signal }) {
  const args = ["--settings", settingsPath, "--model", frontendModel,
    "--output-format", "stream-json", "--verbose", ...isolationArgs, ...extraArgs, "-p"];
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const fields = { events: [], stderr: "", exitCode: null, signal: null,
      timedOut: false, spawnError: null, ioError: null, parseErrors: 0,
      transcriptPath, command: [claudeBin, ...args], pid: null };
    let child, timer, killTimer, drainTimer, settled = false, stopping = false, closed = false;
    let stopReason = null, escalated = false;
    const groupAlive = () => {
      if (!child?.pid) return false;
      if (!grouped) return child.exitCode === null && child.signalCode === null;
      try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
    };
    const onAbort = () => { fields.ioError ??= "CLI aborted"; stop("abort"); };
    let raw = "", bytes = 0;
    const decoder = new StringDecoder("utf8");
    const grouped = process.platform !== "win32";
    const killOwned = (signal) => {
      if (!child?.pid) return;
      if (grouped) { try { process.kill(-child.pid, signal); return; } catch {} }
      if (child.exitCode === null && child.signalCode === null) { try { child.kill(signal); } catch {} }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      const groupGone = !groupAlive();
      fields.cleanup = { ok: closed && groupGone, pid: fields.pid, pgid: grouped ? fields.pid : null,
        groupGone, exitCode: fields.exitCode, signal: fields.signal, forced: stopping,
        escalated, reason: stopReason, scope: "owned process group; independently detached descendants are not observed" };
      raw += decoder.end();
      for (const line of raw.split("\n").filter((line) => line.trim())) {
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("not an event");
          fields.events.push(event);
        } catch { fields.parseErrors += 1; }
      }
      if (transcriptPath) {
        try {
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          fs.writeFileSync(transcriptPath, raw, { mode: 0o600 });
        } catch (error) { fields.ioError ??= `transcript: ${error.code ?? error.message}`; }
      }
      resolve(new HeadlessRun({ ...fields, durationMs: Date.now() - startedAt }));
    };
    const stop = (reason = "transport_error") => {
      if (stopping || settled) return;
      stopping = true; stopReason = reason;
      if (!child?.pid) { finish(); return; }
      killOwned("SIGTERM");
      killTimer = setTimeout(() => {
        escalated = true;
        killOwned("SIGKILL");
        drainTimer = setTimeout(() => {
          child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish();
        }, 1000);
      }, 1000);
    };
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
      fields.spawnError = "invalid timeoutSeconds"; finish(); return;
    }
    try {
      child = spawn(claudeBin, args, { cwd,
        env: { ...sanitizeEnv(env), ...childEnv, CLAUDE_CONFIG_DIR: configDir, CI: "1", FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"], detached: grouped });
      fields.pid = child.pid ?? null;
    } catch (error) { fields.spawnError = error.message; finish(); return; }
    child.stdin.on("error", (error) => { fields.ioError ??= `stdin: ${error.code ?? error.message}`; });
    child.stdin.end(prompt, "utf8"); // Conversation-only values never enter argv.
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { fields.ioError = "stdout exceeded 4 MiB"; stop(); return; }
      raw += decoder.write(chunk);
    });
    child.stderr.on("data", (chunk) => { fields.stderr = (fields.stderr + chunk.toString("utf8")).slice(-200_000); });
    for (const stream of [child.stdout, child.stderr]) stream.on("error", (error) => {
      fields.ioError = error.message; stop();
    });
    child.once("error", (error) => { fields.spawnError = error.message; finish(); });
    child.once("close", (code, exitSignal) => {
      closed = true;
      fields.exitCode = code; fields.signal = exitSignal;
      if (groupAlive()) { stop("descendant_cleanup"); return; }
      finish();
    });
    timer = setTimeout(() => { fields.timedOut = true; stop("deadline"); }, timeoutSeconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const root = (event) => event.parent_tool_use_id == null;
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content)
  ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("\n") : "";

/** Finite nonnegative usage, with genuine aggregate input and output activity. */
export function usageReport(usage) {
  const required = ["input_tokens", "output_tokens"];
  const optional = ["cache_read_input_tokens", "cache_creation_input_tokens"];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { ok: false, missing: true, invalid: [] };
  const missing = required.some((key) => !Object.hasOwn(usage, key));
  const keys = [...required, ...optional].filter((key) => Object.hasOwn(usage, key));
  const invalid = keys.filter((key) => typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0);
  const input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens;
  if (!missing && !invalid.length && !Number.isFinite(input)) invalid.push("input total");
  return { ok: !missing && invalid.length === 0 && input > 0 && output > 0, missing, input, output, invalid };
}

export class HeadlessRun {
  constructor(fields = {}) { Object.assign(this, { events: [], stderr: "", ...fields }); }
  get init() { return this.events.find((event) => root(event) && event.type === "system" && event.subtype === "init") ?? null; }
  get results() { return this.events.filter((event) => root(event) && event.type === "result"); }
  get result() { return this.results.length === 1 ? this.results[0] : null; }

  /** A message ID may deliver one block per record or a repeated full record.
   * Union those blocks while retaining first-observed ordering. Identical tool
   * blocks repeated in that SAME response are replay, not another invocation;
   * conflicting inputs, duplicate IDs within a record or across responses fail.
   */
  get stream() {
    const messages = [], uses = [], results = [], errors = [], missing = [];
    const byMessage = new Map(), byTool = new Map();
    let position = 0;
    for (const [eventIndex, event] of this.events.entries()) {
      if (!root(event)) continue;
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      if (event.type === "assistant") {
        const id = event.message?.id;
        const validId = typeof id === "string" && id.length > 0;
        if (!validId) missing.push(`assistant message.id at event ${eventIndex}`);
        const key = validId ? id : `missing-${eventIndex}`;
        let message = byMessage.get(key);
        if (!message) {
          message = { id: validId ? id : null, index: eventIndex, blocks: [], tools: [], stopReasons: [] };
          messages.push(message); byMessage.set(key, message);
        }
        if (event.error || event.aborted || event.supersedes?.length) errors.push(`assistant error/abort/replacement at ${eventIndex}`);
        if (event.message?.stop_reason != null) message.stopReasons.push(event.message.stop_reason);
        const recordIds = new Set();
        for (const block of blocks) {
          position += 1;
          if (block.type === "tool_use") {
            if (recordIds.has(block.id)) errors.push(`duplicate tool ID in record: ${block.id}`);
            recordIds.add(block.id);
            const prior = byTool.get(block.id);
            if (prior) {
              if (prior.messageId !== key || !isDeepStrictEqual(prior.block, block)) errors.push(`conflicting/duplicate tool ID: ${block.id}`);
              continue;
            }
            const use = { id: block.id, name: block.name, input: block.input ?? {}, position,
              eventIndex, messageId: key, block };
            byTool.set(block.id, use); uses.push(use); message.tools.push(use);
          }
          if (!message.blocks.some((prior) => isDeepStrictEqual(prior.block, block))) {
            message.blocks.push({ block, position, eventIndex });
          }
        }
      } else if (event.type === "user") {
        const returned = blocks.filter((block) => block.type === "tool_result");
        for (const block of returned) results.push({
          id: block.tool_use_id, isError: block.is_error === true, content: textOf(block.content),
          metadata: returned.length === 1 ? event.tool_use_result : undefined,
          eventIndex, position: ++position,
        });
      }
    }
    return { messages, uses, results, errors, missing };
  }
  get toolUses() { return this.stream.uses; }
  get toolResults() { return this.stream.results; }
  get mainBlocks() { return this.stream.messages.flatMap((message) => message.blocks).sort((a, b) => a.position - b.position).map(({ block }) => block); }
  get answer() {
    // Never fall back to the result envelope: it is not a root model response.
    const blocks = this.mainBlocks;
    const lastCall = blocks.map((block) => block.type).lastIndexOf("tool_use");
    return blocks.slice(lastCall + 1).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  }
  get usage() { return this.result?.usage; }
  get inputTokens() { return usageReport(this.usage).input ?? null; }
  get sessionId() { return this.result?.session_id ?? this.init?.session_id ?? null; }
  toolNames() { return [...new Set(this.toolUses.map((use) => use.name))]; }
  usesOf(name) { return this.toolUses.filter((use) => use.name === name); }
  pairingReport() {
    const { uses, results, messages, errors } = this.stream;
    const problems = [...errors];
    const unanswered = [], orphaned = [];
    for (const use of uses) {
      if (typeof use.id !== "string" || !use.id) problems.push("missing tool_use id");
      const matches = results.filter((result) => result.id === use.id);
      if (!matches.length) unanswered.push(use.id);
      if (matches.length > 1) problems.push(`duplicate result: ${use.id}`);
      for (const result of matches) {
        if (result.position <= use.position) problems.push(`result before call: ${use.id}`);
        if (messages.some((message) => message.id !== use.messageId && message.index > use.eventIndex && message.index < result.eventIndex)) {
          problems.push(`next response before tool result: ${use.id}`);
        }
      }
    }
    for (const result of results) if (!uses.some((use) => use.id === result.id)) orphaned.push(result.id);
    const resultIndex = this.events.findIndex((event) => root(event) && event.type === "result");
    if (resultIndex >= 0 && this.events.some((event, index) => index > resultIndex && root(event) && ["assistant", "user"].includes(event.type))) {
      problems.push("content after result envelope");
    }
    return { uses: uses.length, results: results.length, unanswered, orphaned, problems,
      ok: !unanswered.length && !orphaned.length && !problems.length };
  }
  get completed() {
    return this.exitCode === 0 && this.signal == null && !this.timedOut && !this.spawnError && !this.ioError && !this.parseErrors &&
      this.results.length === 1 && this.result.subtype === "success" && this.result.is_error === false;
  }
  get failureHint() {
    if (this.timedOut) return "CLI timed out";
    if (this.spawnError || this.ioError) return String(this.spawnError || this.ioError);
    if (this.exitCode !== 0 || this.signal) return `CLI exit=${this.exitCode} signal=${this.signal ?? "none"}`;
    if (this.parseErrors) return `invalid stream-json records: ${this.parseErrors}`;
    if (this.results.length !== 1) return `expected one result envelope, received ${this.results.length}`;
    if (this.result.subtype !== "success" || this.result.is_error !== false) return `unsuccessful result: ${this.result.subtype}`;
    return null;
  }
}

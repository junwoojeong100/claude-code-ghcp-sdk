/**
 * Headless Claude Code sessions and stream-json reading.
 *
 * Claude Code is a terminal program, so the harness drives it the way CI does:
 * `-p` with `--output-format stream-json`. That stream is the primary evidence
 * for every scenario -- which tools ran, what came back, and which backend
 * actually served the turn.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Strip every inherited ANTHROPIC_* and CLAUDE* variable from the child's
 * environment.
 *
 * Two different contaminations hide here, and both produce a run that looks
 * healthy while measuring the wrong thing:
 *
 *  - ANTHROPIC_BASE_URL / _AUTH_TOKEN / _MODEL point the child at whatever
 *    gateway the launching shell uses, so the bridge is never exercised.
 *  - CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION and the
 *    CLAUDE_CODE_MESSAGING_* pair make the child enrol as a nested agent of
 *    the launching session. It then inherits that session's tool policy --
 *    observed here as a child with no Glob, Grep, TodoWrite or BashOutput but
 *    with the parent's exotic tools attached.
 *
 * The settings file is the only permitted source of connection configuration,
 * and the child must believe it was started from a plain shell.
 */
export function sanitizeEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE)/.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Run one headless turn.
 *
 * Resolves rather than rejects on timeout or non-zero exit: an unhappy run is
 * data a driver has to judge, not an exception to unwind.
 */
export function runHeadless({
  prompt,
  cwd,
  settingsPath,
  frontendModel,
  configDir,
  claudeBin,
  timeoutSeconds,
  extraArgs = [],
  transcriptPath,
  env = process.env,
  // "stream-json" sends the prompt as a user-message envelope instead of raw
  // text, which is the input half of the stream protocol. Only the output half
  // is exercised otherwise, and the two are separate code paths.
  inputFormat = "text",
  replayUserMessages = false,
}) {
  // The prompt goes in on stdin, never in argv.
  //
  // A prompt in argv is visible to anything that reads the process table. A
  // scenario that asks the model to stop a named background process quotes
  // that name in its prompt, so `pkill -f "node ticker.mjs"` -- an entirely
  // reasonable way to do what was asked -- matched the *claude* process of
  // every peer slot whose command line carried the same words, and SIGTERMed
  // them mid-turn. Five slots died inside one second that way. Off argv, a
  // slot's command line says nothing about what the slot is doing.
  const args = [
    "--settings", settingsPath,
    "--model", frontendModel,
    "--output-format", "stream-json",
    "--verbose",
    ...(inputFormat === "stream-json" ? ["--input-format", "stream-json"] : []),
    ...(replayUserMessages ? ["--replay-user-messages"] : []),
    ...extraArgs,
    "-p",
  ];

  const childEnv = {
    ...sanitizeEnv(env),
    CLAUDE_CONFIG_DIR: configDir,
    CI: "1",
    FORCE_COLOR: "0",
  };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(claudeBin, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a timeout can take the tool subprocesses with it.
      detached: true,
    });

    // A closed stdin is how print mode knows the prompt is complete. If the
    // child is already gone, the write fails and the close handler reports it.
    //
    // Under stream-json input the same prompt goes in as a user-message
    // envelope. That is a different parser on the far side, not a different
    // spelling of the same one.
    const payload =
      inputFormat === "stream-json"
        ? `${JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: prompt }] },
          })}\n`
        : prompt;
    child.stdin.on("error", () => {});
    child.stdin.end(payload, "utf8");

    const events = [];
    const rawLines = [];
    let stdoutBuf = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      }, 5000);
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let index;
      while ((index = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, index);
        stdoutBuf = stdoutBuf.slice(index + 1);
        if (!line.trim()) continue;
        rawLines.push(line);
        const event = parseStreamLine(line);
        if (event) events.push(event);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    const finish = (code, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuf.trim()) {
        rawLines.push(stdoutBuf);
        const event = parseStreamLine(stdoutBuf);
        if (event) events.push(event);
      }
      if (transcriptPath) {
        try {
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          fs.writeFileSync(transcriptPath, rawLines.join("\n") + "\n", "utf8");
        } catch {}
      }
      resolve(
        new HeadlessRun({
          events,
          stderr,
          exitCode: code,
          signal,
          timedOut,
          spawnError,
          durationMs: Date.now() - startedAt,
          command: [claudeBin, ...args],
        }),
      );
    };

    child.once("error", (error) => finish(null, null, error.message));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

/* ------------------------------------------------------------------ *
 * Stream reading
 * ------------------------------------------------------------------ */

export class HeadlessRun {
  constructor(fields) {
    Object.assign(this, fields);
  }

  get init() {
    return this.events.find((e) => e.type === "system" && e.subtype === "init") ?? null;
  }

  get result() {
    return this.events.find((e) => e.type === "result") ?? null;
  }

  /**
   * Content blocks this session produced itself.
   *
   * A subagent's blocks ride the same stream, tagged with the `Agent` call that
   * spawned them. They are that agent's output, not this session's answer, so
   * they never count as the session having said something.
   */
  get mainBlocks() {
    return this.events
      .filter((e) => e.type === "assistant" && !e.parent_tool_use_id)
      .flatMap((e) => e.message?.content ?? []);
  }

  /** Assistant prose only: tool arguments are evidence, not an answer. */
  get text() {
    return this.mainBlocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * What the session finally said: its prose after its last tool call.
   *
   * The result envelope cannot be trusted for this. A turn that dispatches an
   * async subagent can finish with `result.result` still holding the preamble
   * the model wrote while dispatching it -- "the scout will report back" --
   * while the report it actually wrote afterwards never reaches the envelope.
   * Judging that text as the answer failed two models for a report they had
   * in fact delivered. The stream carries every block in order, so read the
   * answer from the stream and keep the envelope as a fallback.
   */
  get answer() {
    const blocks = this.mainBlocks;
    const lastCall = blocks.map((block) => block.type).lastIndexOf("tool_use");
    const finalProse = blocks
      .slice(lastCall + 1)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (finalProse) return finalProse;
    const result = this.result;
    if (typeof result?.result === "string" && result.result.trim()) return result.result;
    return this.text;
  }

  get thinkingBlocks() {
    return this.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => e.message?.content ?? [])
      .filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
  }

  get toolUses() {
    return this.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => e.message?.content ?? [])
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, input: block.input ?? {} }));
  }

  get toolResults() {
    return this.events
      .filter((e) => e.type === "user")
      .flatMap((e) => e.message?.content ?? [])
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        id: block.tool_use_id,
        isError: block.is_error === true,
        content: renderToolResult(block.content),
      }));
  }

  toolNames() {
    return [...new Set(this.toolUses.map((use) => use.name))];
  }

  usedTool(...names) {
    const wanted = names.map((n) => n.toLowerCase());
    return this.toolUses.some((use) => wanted.includes(String(use.name).toLowerCase()));
  }

  usesOf(name) {
    const wanted = String(name).toLowerCase();
    return this.toolUses.filter((use) => String(use.name).toLowerCase() === wanted);
  }

  usedToolMatching(pattern) {
    return this.toolUses.some((use) => pattern.test(String(use.name)));
  }

  /** Tool calls that ran before any result came back: real parallelism. */
  parallelBatches() {
    const batches = [];
    for (const event of this.events) {
      if (event.type !== "assistant") continue;
      const uses = (event.message?.content ?? []).filter((b) => b.type === "tool_use");
      if (uses.length > 1) batches.push(uses.map((u) => u.name));
    }
    return batches;
  }

  /** Every tool_use must be answered exactly once. A gap is a wire-level bug. */
  pairingReport() {
    const uses = this.toolUses;
    const results = this.toolResults;
    const resultIds = new Set(results.map((r) => r.id));
    const unanswered = uses.filter((use) => !resultIds.has(use.id)).map((use) => use.name);
    const useIds = new Set(uses.map((use) => use.id));
    const orphaned = results.filter((r) => !useIds.has(r.id)).map((r) => r.id);
    return { uses: uses.length, results: results.length, unanswered, orphaned, ok: unanswered.length === 0 && orphaned.length === 0 };
  }

  get modelUsage() {
    return this.result?.modelUsage ?? {};
  }

  get usage() {
    return this.result?.usage ?? {};
  }

  get inputTokens() {
    const usage = this.usage;
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    );
  }

  get sessionId() {
    return this.result?.session_id ?? this.init?.session_id ?? null;
  }

  get mcpServers() {
    return this.init?.mcp_servers ?? [];
  }

  /**
   * The schema-validated object a --json-schema turn produced.
   *
   * Claude Code validates and retries against the schema itself, so a parsed
   * object here means the whole validator path survived the bridge. The
   * envelope has carried it under more than one key across versions, and the
   * string form is the fallback when only the prose made it.
   */
  get structuredOutput() {
    const result = this.result;
    for (const candidate of [result?.structured_output, result?.structuredOutput]) {
      if (candidate && typeof candidate === "object") return candidate;
    }
    if (typeof result?.result === "string") {
      try {
        const parsed = JSON.parse(result.result);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
    return null;
  }

  /**
   * User messages the CLI echoed back under --replay-user-messages.
   *
   * A replay only exists if the input envelope was parsed, so its presence is
   * the one piece of evidence that the stream-json INPUT path ran rather than
   * the plain-text one.
   */
  get replayedUserMessages() {
    return this.events.filter((event) => event.type === "user" && event.isReplay === true);
  }

  get permissionDenials() {
    return this.result?.permission_denials ?? [];
  }

  /** Did a turn actually complete? A crash or timeout is not a verdict. */
  get completed() {
    return this.result !== null && !this.timedOut;
  }

  get failureHint() {
    if (this.timedOut) return `timed out after ${Math.round(this.durationMs / 1000)}s`;
    if (this.spawnError) return `spawn failed: ${this.spawnError}`;
    if (!this.result) {
      const tail = this.stderr.trim().split("\n").slice(-3).join(" | ");
      return `no result event (exit=${this.exitCode}${tail ? `, stderr: ${tail}` : ""})`;
    }
    if (this.result.is_error) return `result reported error: ${String(this.result.result ?? "").slice(0, 200)}`;
    return null;
  }
}

function renderToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * Confirm the Copilot model named in modelUsage is the one the slot asked for.
 *
 * The displayed label is a frontend alias and cannot be trusted for this;
 * modelUsage is what the turn actually billed.
 */
export function servedModels(run) {
  return Object.keys(run.modelUsage ?? {});
}

export function servedExpectedModel(run, { model, frontendModel }) {
  const served = servedModels(run);
  if (served.length === 0) return { ok: false, served, reason: "modelUsage was empty" };
  // The `[1m]` window hint is not part of the model's identity; compare
  // without it so a launch id with the hint matches a usage key without it.
  const bare = (id) => id.toLowerCase().replace(/\[(?:1m|\d+k)\]$/, "");
  const wanted = [model, frontendModel].filter(Boolean).map(bare);
  const match = served.some((id) => {
    const lower = bare(id);
    return wanted.some((w) => lower === w || lower.endsWith(`/${w}`) || lower.includes(w));
  });
  return match
    ? { ok: true, served }
    : { ok: false, served, reason: `modelUsage names ${served.join(", ")}, expected ${model}` };
}

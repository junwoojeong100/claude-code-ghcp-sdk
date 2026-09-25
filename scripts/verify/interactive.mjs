/** Narrow native Claude PTY transport. Terminal display is never answer evidence. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { StartupDialogs, terminalActivity, interruptionLines } from "./native-dialogs.mjs";
import xterm from "@xterm/headless";
import { HeadlessRun } from "./session.mjs";
import { createRecording } from "./recording.mjs";
import { PRIMARY_MODELS, copilotModelForFrontend } from "../../src/model-map.mjs";

const { Terminal } = xterm;
const HELPER = fileURLToPath(new URL("./pty.py", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ESCAPE_PURPOSES = ["test-interrupt", "cleanup", "picker-dismiss"];
const PHASE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const aborted = () => Object.assign(new Error("Native observer aborted"), { name: "AbortError", code: "ABORT_ERR" });
// Remove listeners/timers on every path; cancellation must not leave a polling
// observer running after the caller begins cleanup or a recovery turn.
function cancellable(promise, { signals = [], deadline = Infinity, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const cleanup = () => { clearTimeout(timer); for (const signal of signals) signal?.removeEventListener("abort", onAbort); };
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const onAbort = () => finish(reject, aborted());
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    for (const signal of signals) signal?.addEventListener("abort", onAbort, { once: true });
    if (signals.some(signal => signal?.aborted)) { onAbort(); return; }
    if (Number.isFinite(deadline)) timer = setTimeout(() => finish(reject,
      Object.assign(new Error(`Timed out waiting for ${label}`), { code: "ETIMEDOUT" })), Math.max(0, deadline - Date.now()));
  });
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
const textOf = (event) => typeof event.message?.content === "string" ? event.message.content
  : (event.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const isNativeInterruption = event => event.type === "user" &&
  /^\[Request interrupted by user(?: for tool use)?\]$/.test(textOf(event).trim());
const isOrdinaryUser = event => event.type === "user" && !event.isMeta && !isNativeInterruption(event) &&
  !(Array.isArray(event.message?.content) && event.message.content.length > 0 &&
    event.message.content.every(part => part.type === "tool_result"));
const bounded = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 86_400_000) throw new RangeError(`${name} must be a finite bounded positive integer`);
  return n;
};

/** Minimal child-only environment; credentials are explicit settings, not inherited. */
export function privateCLIEnv({ home, configDir, tmpDir, env = {} }) {
  const allowed = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR"];
  return {
    ...Object.fromEntries(allowed.filter((key) => env[key]).map((key) => [key, env[key]])),
    PATH: env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    TERM: "xterm-256color", LANG: "en_US.UTF-8", COLORTERM: "truecolor",
    DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "false", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "0",
  };
}

export function normalizeNativeEvent(event) {
  // Native sessionId is the saved conversation; compact summaries may retain an
  // earlier embedded session_id from the request that produced their contents.
  return { ...event, ...(event.sessionId ? { session_id: event.sessionId } : {}),
    ...(event.isSidechain && event.parent_tool_use_id == null ? { parent_tool_use_id: event.agentId ?? "native-sidechain" } : {}) };
}

/** Native records can be flushed before their parents; disk order is not turn order. */
export function orderNativeEvents(events) {
  const byId = new Map(events.filter(e => e.uuid).map(e => [e.uuid, e]));
  const ordered = [], visited = new Set(), visiting = new Set();
  const visit = event => {
    if (visited.has(event)) return;
    if (visiting.has(event)) throw new Error("Cycle in native transcript");
    visiting.add(event);
    const parent = byId.get(event.parentUuid);
    if (parent) visit(parent);
    visiting.delete(event); visited.add(event); ordered.push(event);
  };
  events.forEach(visit);
  return ordered;
}

export function parsePicker(screen) {
  const section = screen.slice(screen.lastIndexOf("Select model"));
  const rows = section.split("\n").filter(line => /^\s*(?:❯\s*)?\d+\./u.test(line));
  const entries = rows.map(line => ({ line, model: [...line.matchAll(/\(([^()]+)\)/g)]
    .map(match => copilotModelForFrontend(match[1])).find(id => PRIMARY_MODELS.includes(id)) }));
  const current = entries.filter(row => row.line.includes("✔") && row.model);
  return { models: [...new Set(entries.filter(row => !/Default \(recommended\)/.test(row.line)).map(row => row.model).filter(Boolean))],
    current: current.length === 1 ? current[0].model : null, screen };
}

export class InteractiveSession {
  constructor({ claudeBin, workspace, configDir, settingsPath, frontendModel, slotDir,
    sessionId = randomUUID(), tools = [], mcpConfig = { mcpServers: {} }, timeoutMs = 420_000,
    env = process.env, bare = false, maxBytes = 4 * 1024 * 1024, signal }) {
    this.options = { claudeBin, workspace, configDir, settingsPath, frontendModel, slotDir,
      tools, mcpConfig, timeoutMs: bounded(timeoutMs, "timeoutMs"), env, bare, maxBytes, signal };
    this.sessionId = sessionId;
    this.launchId = randomUUID();
    this.pid = null;
    this.exit = null;
    this.error = null;
    this.startedAt = null;
    this.parseErrors = 0;
    this.terminal = new Terminal({ cols: 160, rows: 48, scrollback: 3000, allowProposedApi: true });
    this.writeQueue = Promise.resolve();
    this.decoder = new StringDecoder("utf8");
    this.files = new Map();
    this.inputs = [];
    this.activeSubmit = false;
    this.outputBytes = 0;
    this.outputSequence = 0;
    this.renderSequence = 0;
    this.renderedOutputSequence = 0;
    this.inputSequence = 0;
    this.inputReceipts = [];
    this.pendingInputs = new Map();
    this.lastOutputAt = 0;
    this.lastInputAt = 0;
    this.lastDeviceReplyAt = 0;
    this.currentTurn = null;
    this.terminal.onData(data => this.input(data, { kind: "device-reply", purpose: "terminal-query" }));
  }

  async start({ resume = false } = {}) {
    if (this.child) throw new Error("InteractiveSession is single-use");
    const o = this.options;
    if (o.signal?.aborted) throw aborted();
    for (const dir of [o.workspace, o.configDir, o.slotDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ownedWorkspace = fs.realpathSync(o.workspace), ownedStat = fs.lstatSync(o.workspace);
    const validateWorkspace = () => {
      const current = fs.lstatSync(o.workspace);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedStat.dev || current.ino !== ownedStat.ino ||
          fs.realpathSync(o.workspace) !== ownedWorkspace || ownedWorkspace === path.parse(ownedWorkspace).root) {
        throw new Error("Refusing trust confirmation for an unowned workspace");
      }
    };
    validateWorkspace();
    const home = path.join(o.configDir, "home");
    const tmpDir = path.join(o.configDir, "tmp");
    for (const dir of [home, tmpDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const original = fs.readFileSync(o.settingsPath, "utf8");
    const settings = JSON.parse(original);
    // Keep the production routing/settings file unchanged; the extra private file
    // changes only documented isolation controls and has a recorded digest.
    const isolated = { ...settings, disableAllHooks: true, autoMemoryEnabled: false,
      enableAllProjectMcpServers: false, enabledPlugins: {}, promptSuggestionEnabled: false };
    this.isolationSettingsPath = path.join(o.slotDir, `native-settings-${this.launchId}.json`);
    fs.writeFileSync(this.isolationSettingsPath, `${JSON.stringify(isolated, null, 2)}\n`, { mode: 0o600 });
    const args = ["--settings", this.isolationSettingsPath, "--model", o.frontendModel,
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(o.mcpConfig),
      "--no-chrome", "--permission-mode", "dontAsk",
      "--tools", o.tools.join(","), ...(o.tools.length ? ["--allowedTools", o.tools.join(",")] : []),
      ...(o.bare ? ["--bare"] : []), resume ? "--resume" : "--session-id", this.sessionId];
    this.launchPolicy = {
      args, settingsPath: o.settingsPath, settingsSha256: hash(original),
      isolationSettingsPath: this.isolationSettingsPath,
      isolationSettingsSha256: hash(fs.readFileSync(this.isolationSettingsPath)),
      settings: { disableAllHooks: true, autoMemoryEnabled: false, enabledPlugins: {}, enableAllProjectMcpServers: false },
      home, configDir: o.configDir, workspace: o.workspace, tmpDir,
      tools: [...o.tools], mcpServers: Object.keys(o.mcpConfig.mcpServers ?? {}),
      settingSources: [], strictMcpConfig: true, bare: o.bare,
      envKeys: Object.keys(privateCLIEnv({ home, configDir: o.configDir, tmpDir, env: o.env })),
    };
    this.startedAt = Date.now();
    this.rawPath = path.join(o.slotDir, `terminal-${this.launchId}.log`);
    fs.writeFileSync(this.rawPath, "", { mode: 0o600 });
    // Output-only recording beside the raw log; its header is fixed at 160x48, so
    // another PTY size is not recorded. Capture failures only change its footer.
    if (this.terminal.cols === 160 && this.terminal.rows === 48) {
      // The recorder and readRecording refuse symlinked ancestors such as macOS /var.
      let dir = o.slotDir;
      try { dir = fs.realpathSync(dir); } catch {}
      this.recordingPath = path.join(dir, `terminal-output-${this.launchId}.jsonl`);
      this.recording = createRecording(this.recordingPath, { launch: this.launchId, session: this.sessionId });
    }
    this.receiptsPath = path.join(o.slotDir, `terminal-events-${this.launchId}.jsonl`);
    fs.writeFileSync(this.receiptsPath, "", { mode: 0o600 });
    this.child = spawn("python3", [HELPER, JSON.stringify({ argv: [o.claudeBin, ...args], cwd: o.workspace,
      cols: this.terminal.cols, rows: this.terminal.rows, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes })], {
      cwd: o.workspace, env: privateCLIEnv({ home, configDir: o.configDir, tmpDir, env: o.env }),
      stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    this.helperPid = this.child.pid;
    this.onAbort = () => { this.error ??= new Error("Native session aborted"); void this.close(); };
    o.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (o.signal?.aborted) this.onAbort();
    let lines = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      lines += chunk;
      if (lines.length > o.maxBytes * 2) { this.error = new Error("PTY protocol output overflow"); void this.close(); return; }
      while (lines.includes("\n")) {
        const at = lines.indexOf("\n");
        const line = lines.slice(0, at); lines = lines.slice(at + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "start") this.pid = event.pid;
          else if (event.type === "exit") this.exit = event;
          else if (event.type === "input_ack") this.acknowledgeInput(event);
          else if (event.type === "output") this.receiveOutput(Buffer.from(event.data, "base64"), event.sequence);
        } catch (error) { this.error = error; }
      }
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-100_000); });
    this.child.stdin.on("error", (error) => { if (!this.exit) this.error = error; });
    this.child.once("error", (error) => { this.error = error; });
    this.child.once("close", () => { this.helperClosed = true; });
    // Progress is monotonic: select once, observe a newer affirmative render
    // after device replies drain, confirm once, and require actual dismissal.
    const dialogs = this.startupDialogs = new StartupDialogs({ workspace: ownedWorkspace, settings, validateWorkspace });
    await this.waitFor(async () => {
      // The pinned CLI can reset the initial selection during late startup.
      // Require a quiet rendered dialog, not merely the first visible prompt.
      const activity = this.activity(), drained = this.renderDrained(1000);
      const action = dialogs.next({ ...activity, outputSequence: this.renderedOutputSequence, drained });
      if (action) {
        const receipt = await this.writeInput(action.data, { kind: action.kind, purpose: action.purpose, timeoutMs: 3000 });
        dialogs.acknowledge(action, receipt);
        return false;
      }
      return drained && dialogs.dismissed && activity.ready;
    }, { timeoutMs: Math.min(o.timeoutMs, 30_000), label: "native prompt readiness" });
    this.ready = true;
    const servers = Object.keys(o.mcpConfig.mcpServers ?? {});
    if (servers.length) {
      await this.enter("/mcp");
      await this.waitFor(() => {
        const screen = this.screen();
        return /Manage MCP servers/.test(screen) && servers.every(name => screen.split("\n").some(line => {
          const row = line.trim().replace(/^❯\s*/, "");
          return row.startsWith(`✔ ${name} `) && /\b[1-9]\d* tools?\b/.test(row);
        }));
      }, { timeoutMs: Math.min(o.timeoutMs, 15000), label: "declared MCP tools ready" });
      this.launchPolicy.mcpReadyScreen = this.screen();
      await this.writeInput("\x1b", { kind: "escape", purpose: "mcp-dismiss" });
      await this.waitFor(() => this.activity().ready, { timeoutMs: 5000, label: "MCP panel dismissal" });
    }
    return this.result([]);
  }

  screen() {
    const b = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? "").join("\n").trimEnd();
  }

  interruptionCount() {
    const buffer = this.terminal.buffer.active;
    let count = 0;
    for (let i = 0; i < buffer.length; i++) count += interruptionLines(buffer.getLine(i)?.translateToString(true) ?? "").length;
    return count;
  }

  activity() {
    const screen = this.screen();
    return { renderSequence: this.renderSequence, screen, ...terminalActivity(screen) };
  }

  elapsedMs() { return Math.max(0, Date.now() - (this.startedAt ?? Date.now())); }

  record(observation) {
    if (this.receiptsPath) fs.appendFileSync(this.receiptsPath, JSON.stringify(observation) + "\n");
  }

  receiveOutput(bytes, sequence) {
    if (sequence !== this.outputSequence + 1) throw new Error("Out-of-order PTY output");
    const byteOffset = this.outputBytes;
    this.outputBytes += bytes.length;
    if (this.outputBytes > this.options.maxBytes) throw new Error("terminal output overflow");
    this.outputSequence = sequence;
    this.lastOutputAt = Date.now();
    if (this.rawPath) { fs.appendFileSync(this.rawPath, bytes); this.recording?.output(bytes); }
    this.record({ kind: "output", sequence, elapsedMs: this.elapsedMs(), byteOffset, byteCount: bytes.length });
    const data = this.decoder.write(bytes);
    this.writeQueue = this.writeQueue.then(() => new Promise(resolve => this.terminal.write(data, () => {
      this.renderedOutputSequence = sequence;
      this.renderSequence++;
      const activity = this.activity();
      try { this.startupDialogs?.observe({ ...activity, outputSequence: sequence }); }
      catch (error) { this.error ??= error; }
      this.record({ kind: "render", renderSequence: this.renderSequence, outputSequence: sequence,
        elapsedMs: this.elapsedMs(), screenSha256: hash(activity.screen), active: activity.active,
        interruptible: activity.interruptible, ready: activity.ready });
      const turn = this.currentTurn, escape = turn?.escape;
      if (escape?.accepted && sequence > escape.writeOutputSequence && this.renderSequence > escape.renderSequence) {
        const count = this.interruptionCount();
        // Clearing/repainting an old line does not create a new interruption.
        // Include scrollback so scrolling an old marker into view cannot qualify.
        if (activity.ready && count > turn.markerCount) {
          turn.renderedReceipt ??= { kind: "render", renderSequence: this.renderSequence,
            outputSequence: sequence, elapsedMs: this.elapsedMs(), screen: activity.screen };
        }
      }
      resolve();
    })));
    this.writeQueue.catch(error => { this.error ??= error; });
    return this.writeQueue;
  }

  /** Phase marker in the output recording, if one is active; never throws or affects verdicts. */
  markPhase(label) {
    if (typeof label === "string" && PHASE_LABEL.test(label)) this.recording?.phase(label);
  }

  renderDrained(quietMs = 100) {
    return this.renderedOutputSequence === this.outputSequence && !this.pendingInputs.size &&
      Date.now() - Math.max(this.lastOutputAt, this.lastDeviceReplyAt, this.lastInputAt) >= quietMs;
  }

  input(data, { kind = "input", purpose = "transport" } = {}) {
    if (!this.child || this.exit || this.helperClosed || this.child.stdin.destroyed) return null;
    const bytes = Buffer.from(data, "utf8");
    if (!bytes.length || bytes.length > this.options.maxBytes) throw new Error("Invalid PTY input size");
    const receipt = { kind, purpose, sequence: ++this.inputSequence, renderSequence: this.renderSequence,
      outputSequence: this.outputSequence, elapsedMs: this.elapsedMs(), byteCount: bytes.length, accepted: false };
    this.pendingInputs.set(receipt.sequence, receipt);
    this.lastInputAt = Date.now();
    this.record({ ...receipt, kind: "input-request", inputKind: kind });
    this.child.stdin.write(`${JSON.stringify({ type: "input", sequence: receipt.sequence, data: bytes.toString("base64") })}\n`);
    return receipt;
  }

  acknowledgeInput(event) {
    const receipt = this.pendingInputs.get(event.sequence);
    if (!receipt || event.accepted !== true || event.byteCount !== receipt.byteCount ||
        event.outputSequence !== this.outputSequence || !Number.isFinite(event.elapsedMs)) {
      throw new Error("Invalid PTY input acknowledgment");
    }
    this.pendingInputs.delete(event.sequence);
    Object.assign(receipt, { accepted: true, acknowledgedMs: this.elapsedMs(), helperElapsedMs: event.elapsedMs,
      writeOutputSequence: event.outputSequence });
    if (receipt.kind === "device-reply") this.lastDeviceReplyAt = Date.now();
    this.inputReceipts.push(receipt);
    this.record(receipt); // Never record the raw input, even for device replies.
  }

  async writeInput(data, { timeoutMs = 5000, signal, ...metadata } = {}) {
    if (signal?.aborted || this.options.signal?.aborted) throw aborted();
    const receipt = this.input(data, metadata);
    if (!receipt) throw new Error("Native input transport is closed");
    await this.waitFor(() => {
      if (receipt.accepted) return true;
      if (this.exit || this.helperClosed) throw new Error("CLI exited before PTY input acknowledgment");
      return false;
    }, { timeoutMs, signal, allowExit: true, label: "PTY input acknowledgment" });
    return { ...receipt };
  }

  async waitFor(predicate, { timeoutMs = 30_000, label = "condition", allowExit = false, signal } = {}) {
    const deadline = Math.min((this.startedAt ?? Date.now()) + this.options.timeoutMs, Date.now() + bounded(timeoutMs, "timeoutMs"));
    const signals = [signal, this.options.signal].filter(Boolean);
    const check = () => {
      if (signals.some(s => s.aborted)) throw aborted();
      if (this.error) throw this.error;
      if (!allowExit && (this.exit || this.helperClosed)) throw new Error(`CLI exited waiting for ${label}: ${JSON.stringify(this.exit)} ${this.stderr}`);
    };
    try {
      while (Date.now() < deadline) {
        check();
        await cancellable(this.writeQueue, { signals, deadline, label });
        check();
        const value = await cancellable(predicate(this), { signals, deadline, label });
        check();
        if (value) return value;
        await cancellable(delay(25), { signals, deadline, label });
      }
      throw Object.assign(new Error(`Timed out waiting for ${label}`), { code: "ETIMEDOUT" });
    } catch (error) {
      if (error.code === "ETIMEDOUT") error.screen = this.screen();
      throw error;
    }
  }

  /** All complete native records for the current session; no synthetic result. */
  readEvents() {
    const root = path.join(this.options.configDir, "projects");
    const found = [];
    if (!fs.existsSync(root)) return [];
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const directory = path.join(root, project.name);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
        const file = path.join(directory, entry.name);
        if (fs.statSync(file).size > this.options.maxBytes) throw new Error("Native transcript exceeded output limit");
        const raw = fs.readFileSync(file, "utf8");
        const events = [];
        for (const line of raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n").filter(Boolean)) {
          try { events.push(normalizeNativeEvent(JSON.parse(line))); } catch { this.parseErrors++; }
        }
        const ordered = orderNativeEvents(events);
        this.files.set(file, ordered);
        if (entry.name === `${this.sessionId}.jsonl`) { this.transcriptPath = file; found.push(...ordered); }
      }
    }
    return found;
  }

  snapshot() {
    this.readEvents();
    const before = new Set([...this.files.values()].flat().map(e => e.uuid ?? hash(JSON.stringify(e))));
    before.files = new Set(this.files.keys());
    return before;
  }

  freshEvents(before, { clearFrom = null } = {}) {
    this.readEvents();
    const isFresh = event => !before.has(event.uuid ?? hash(JSON.stringify(event)));
    if (clearFrom && this.sessionId === clearFrom) {
      // Native cwd may use the canonical /private/tmp spelling of our /tmp
      // workspace. Compare directory identity without changing startup trust.
      const ownsCwd = cwd => {
        if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
        try { return fs.realpathSync(cwd) === fs.realpathSync(this.options.workspace); }
        catch { return false; }
      };
      const candidates = [...this.files.entries()].filter(([file, events]) => !before.files?.has(file) &&
        path.basename(file, ".jsonl") !== clearFrom && events.some(event => isFresh(event) &&
          !event.isSidechain && event.parent_tool_use_id == null && ownsCwd(event.cwd) &&
          event.session_id === path.basename(file, ".jsonl") &&
          (event.type === "user" || event.type === "system" && event.subtype === "local_command") &&
          String(event.content ?? textOf(event)).startsWith("<command-name>/clear</command-name>")));
      if (candidates.length > 1) throw new Error("Ambiguous native /clear session transition");
      if (candidates.length === 1) this.sessionId = path.basename(candidates[0][0], ".jsonl");
    }
    const owned = [...this.files.entries()].filter(([file]) => path.basename(file, ".jsonl") === this.sessionId);
    if (owned.length > 1) throw new Error("Ambiguous owned native transcript");
    if (!owned.length) return [];
    const [file, events] = owned[0];
    this.transcriptPath = file;
    return events.filter(event => isFresh(event) && (event.session_id == null || event.session_id === this.sessionId));
  }

  result(events, extra = {}) {
    const parsed = new HeadlessRun({ events });
    return { events, nativeTurn: true, sessionId: this.sessionId, observedSessionId: this.sessionId,
      answer: parsed.answer, pid: this.pid, helperPid: this.helperPid, transcriptPath: this.transcriptPath ?? null,
      terminalPath: this.rawPath, terminalEventsPath: this.receiptsPath, terminalOutputPath: this.recordingPath ?? null,
      screen: this.screen(), launchPolicy: this.launchPolicy,
      renderSequence: this.renderSequence, outputSequence: this.renderedOutputSequence,
      inputReceipts: this.inputReceipts.map(receipt => ({ ...receipt })),
      parseErrors: this.parseErrors, stderr: this.stderr, exitCode: this.exit?.exitCode ?? null,
      signal: this.exit?.signal ?? null, timedOut: false, spawnError: null, ioError: this.error?.message ?? null, ...extra };
  }

  async enter(text, { timeoutMs = 5000, signal } = {}) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024 || /\x1b/.test(text)) throw new Error("Invalid native input");
    if (signal?.aborted || this.options.signal?.aborted) throw aborted();
    this.inputs.push(text); // In-memory isolation audit only; not an input receipt.
    const deadline = Date.now() + bounded(timeoutMs, "timeoutMs");
    const remaining = () => Math.max(1, deadline - Date.now());
    await this.writeInput(`\x1b[200~${text}\x1b[201~`, { kind: "paste", purpose: "native-input", timeoutMs: remaining(), signal });
    // The paste and Enter must be distinct fully-written batches. Do not send
    // Enter after a cancelled observer, even if its paste was already written.
    await this.waitFor(() => Date.now() - this.lastInputAt >= 30, { timeoutMs: remaining(), signal, label: "paste boundary" });
    return this.writeInput("\r", { kind: "enter", purpose: "native-input", timeoutMs: remaining(), signal });
  }

  async submit(prompt, { timeoutMs = 120_000, signal } = {}) {
    if (this.activeSubmit) throw new Error("A native turn is already active");
    if (signal?.aborted || this.options.signal?.aborted) throw aborted();
    const deadline = Date.now() + bounded(timeoutMs, "timeoutMs");
    const before = this.snapshot();
    const turn = this.currentTurn = { before, escape: null, renderedReceipt: null };
    this.activeSubmit = true;
    let events = [], interruption = null;
    try {
      const entered = await this.enter(prompt, { timeoutMs: Math.min(timeoutMs, 5000), signal });
      await this.waitFor(() => {
        events = this.freshEvents(before);
        const user = events.findIndex(e => e.type === "user" && !e.isMeta && !e.isSidechain && e.parent_tool_use_id == null && textOf(e) === prompt);
        if (user < 0) return false;
        const submitted = events[user];
        if (!submitted.uuid) throw new Error("Native submitted user has no UUID");
        // A preceding turn may flush after this turn's snapshot. Only proven
        // ancestors of the submitted user are old history, not fresh answers.
        const owned = this.files.get(this.transcriptPath) ?? events;
        const byId = new Map(owned.filter(e => e.uuid).map(e => [e.uuid, e]));
        const ancestors = new Set();
        for (let id = submitted.parentUuid; id != null; id = byId.get(id).parentUuid) {
          if (ancestors.has(id) || id === submitted.uuid) throw new Error("Cycle in native turn ancestry");
          // A missing link is not a root: an earlier turn can still be buffered.
          // Wait within the existing deadline before accepting or rejecting it.
          if (!byId.has(id)) return false;
          ancestors.add(id);
        }
        events = events.filter(e => !ancestors.has(e.uuid));
        const descendants = new Set([submitted.uuid]);
        for (const event of events) {
          if (event.uuid && descendants.has(event.parentUuid) && !isOrdinaryUser(event)) descendants.add(event.uuid);
        }
        // A second ordinary root user starts another turn, even when it is
        // linked to this one or this turn already has its own completed answer.
        if (events.some(e => !e.isSidechain && e.parent_tool_use_id == null && isOrdinaryUser(e) && e.uuid !== submitted.uuid)) {
          throw new Error("Unrelated root messages in native turn");
        }
        const rootEvents = events.filter(e => descendants.has(e.uuid) && !e.isSidechain && e.parent_tool_use_id == null);
        const activity = this.activity(), escape = turn.escape;
        const idle = activity.ready && this.renderedOutputSequence === this.outputSequence &&
          this.renderSequence > entered.renderSequence && this.renderedOutputSequence > entered.writeOutputSequence;
        const done = rootEvents.some(e => e.type === "assistant" && ["end_turn", "stop_sequence", "max_tokens", "refusal"].includes(e.message?.stop_reason));
        // A completed turn followed by Escape is completion, not interruption.
        if (idle && (done || escape?.accepted)) {
          const unrelated = events.some(e => !e.isSidechain && e.parent_tool_use_id == null &&
            (e.type === "assistant" || isOrdinaryUser(e)) && !descendants.has(e.uuid));
          if (unrelated) throw new Error("Unrelated root messages in native turn");
        }
        if (done) return idle;
        if (!escape?.accepted || !idle || this.renderSequence <= escape.renderSequence ||
            this.renderedOutputSequence <= escape.writeOutputSequence) return false;
        const event = rootEvents.slice(1).find(e => isNativeInterruption(e) &&
          !turn.beforeEscape.has(e.uuid ?? hash(JSON.stringify(e))));
        const nativeReceipt = event ? { kind: "event", event, renderSequence: this.renderSequence,
          outputSequence: this.renderedOutputSequence, elapsedMs: this.elapsedMs() } : turn.renderedReceipt;
        if (!nativeReceipt) return false;
        interruption = { nativeReceipt, ready: true, renderSequence: this.renderSequence,
          outputSequence: this.renderedOutputSequence, screen: activity.screen, escapeSequence: escape.sequence };
        this.record({ kind: "interruption", ...interruption });
        return true;
      }, { timeoutMs: Math.max(1, deadline - Date.now()), signal, label: "fresh native turn" });
      return this.result(events, { interrupted: Boolean(interruption), interruption });
    } catch (error) {
      error.result = this.result(events, { interrupted: false, interruption: null,
        cancelled: error.code === "ABORT_ERR", timedOut: error.code === "ETIMEDOUT" });
      throw error;
    } finally {
      this.activeSubmit = false;
      if (this.currentTurn === turn) this.currentTurn = null;
    }
  }

  async command(text, { timeoutMs = 60_000 } = {}) {
    if (!/^\/(?:model(?: .+)?|effort(?: .+)?|clear|compact(?: .+)?|exit)$/.test(text)) throw new Error(`Unsupported verifier command: ${text}`);
    if (this.activeSubmit) throw new Error("Wait for the native turn before sending a command");
    const before = this.snapshot();
    const previousSession = this.sessionId;
    const deadline = Date.now() + bounded(timeoutMs, "timeoutMs");
    const entered = await this.enter(text, { timeoutMs: Math.min(timeoutMs, 5000) });
    let events = [], confirmed = false;
    try {
      await this.waitFor(() => {
        events = this.freshEvents(before, { clearFrom: text === "/clear" ? previousSession : null });
        const screen = this.screen();
        if (text === "/exit") return this.exit;
        if (text === "/model") return /Select model/.test(screen) && parsePicker(screen).current;
        if (text.startsWith("/model ") && /Switch model\?/.test(screen)) {
          if (!confirmed && /❯\s*1\. Yes, switch to/.test(screen)) {
            confirmed = true; this.input("\r");
          }
          return false;
        }
        const local = events.filter(e => (e.type === "system" && e.subtype === "local_command") ||
          (e.type === "user" && textOf(e).startsWith("<local-command-stdout>"))).map(e => e.content ?? textOf(e)).join("\n");
        if (text.startsWith("/model ")) return /Set model|Switched.*model/i.test(local);
        if (text.startsWith("/effort")) return /effort/i.test(local);
        if (text === "/clear") return this.sessionId !== previousSession && /(?:^|\n)\s*❯\s*(?:\n|$)/u.test(screen);
        if (text.startsWith("/compact")) {
          const root = events.filter(e => e.session_id === previousSession && !e.isSidechain && e.parent_tool_use_id == null);
          const boundaries = root.filter(e => e.type === "system" && e.subtype === "compact_boundary" && e.compactMetadata?.trigger === "manual");
          const summaries = root.filter(e => e.isCompactSummary === true && e.type === "user" && e.message?.role === "user" &&
            typeof e.message.content === "string" && e.message.content.trim() && e.parentUuid === boundaries[0]?.uuid);
          return boundaries.length === 1 && summaries.length === 1 && this.activity().ready &&
            this.renderSequence > entered.renderSequence && this.renderedOutputSequence > entered.writeOutputSequence;
        }
        return false;
      }, { timeoutMs: Math.max(1, deadline - Date.now()), label: text, allowExit: text === "/exit" });
      return this.result(events, text === "/model" ? { picker: parsePicker(this.screen()) } : {});
    } catch (error) {
      error.result = this.result(events, { timedOut: error.code === "ETIMEDOUT" });
      throw error;
    }
  }

  async escape({ purpose, timeoutMs = 5000 } = {}) {
    if (!ESCAPE_PURPOSES.includes(purpose)) throw new TypeError(`Escape purpose must be one of ${ESCAPE_PURPOSES.join(", ")}`);
    const deadline = Date.now() + bounded(timeoutMs, "timeoutMs");
    await cancellable(this.writeQueue, { signals: [this.options.signal], deadline, label: "pre-Escape render" });
    const screen = this.screen(), picker = /Select model/.test(screen);
    const turn = !picker && purpose === "test-interrupt" ? this.currentTurn : null;
    if (turn?.escape) throw new Error("Only one test Escape is allowed per native turn");
    if (turn) {
      turn.beforeEscape = this.snapshot();
      turn.markerCount = this.interruptionCount();
    }
    const receipt = this.input("\x1b", { kind: "escape", purpose });
    if (!receipt) throw new Error("Native input transport is closed");
    if (turn) turn.escape = receipt;
    await this.waitFor(() => receipt.accepted,
      { timeoutMs: Math.max(1, deadline - Date.now()), label: "Escape PTY acknowledgment" });
    if (picker && !this.activeSubmit) await this.waitFor(() => !/Select model/.test(this.screen()) && this.activity().ready,
      { timeoutMs: Math.max(1, deadline - Date.now()), label: "picker dismissal" });
    return { ...receipt };
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.child) { this.recording?.finish({ complete: false }); return { ok: true, pid: null, groupGone: true, notStarted: true }; }
      this.options.signal?.removeEventListener("abort", this.onAbort);
      let forced = false;
      if (!this.exit && this.ready && !this.activeSubmit && !this.error && !this.options.signal?.aborted && this.activity().ready) {
        try {
          await this.enter("/exit", { timeoutMs: 2000 });
          const gracefulDeadline = Date.now() + 3000;
          while (!this.exit && !this.helperClosed && Date.now() < gracefulDeadline) await delay(25);
        } catch { /* Always continue to owned-process cleanup if graceful exit fails. */ }
      }
      if (!this.exit && !this.helperClosed && !this.child.stdin.destroyed) {
        forced = true;
        this.child.stdin.write(`${JSON.stringify({ type: "close" })}\n`);
      }
      const deadline = Date.now() + 5000;
      while (!this.helperClosed && Date.now() < deadline) await delay(25);
      if (!this.helperClosed) {
        // The helper owns a separate PTY group; never signal unrelated sessions.
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          if (this.pid) { try { process.kill(-this.pid, signal); } catch {} }
          try { process.kill(-this.helperPid, signal); } catch {}
        }
        this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy(); this.child.unref();
      }
      const alive = (pid) => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
      const groupGone = this.pid != null && !alive(this.pid);
      const helperGone = this.helperPid != null && !alive(this.helperPid);
      const receipt = { ...(this.exit ?? {}), pid: this.pid, helperPid: this.helperPid, helperGone, groupGone, forced,
        ok: this.exit?.ok === true && groupGone && helperGone, terminalPath: this.rawPath };
      this.recording?.finish({ complete: receipt.ok && !forced && !this.error && receipt.exitCode === 0 && receipt.signal == null });
      fs.writeFileSync(path.join(this.options.slotDir, `cleanup-${this.pid ?? "unstarted"}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      this.terminal.dispose();
      return receipt;
    })();
    return this.closing;
  }
}

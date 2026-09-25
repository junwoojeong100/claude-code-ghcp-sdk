/** Fail-closed startup dialog state; no trust configuration is changed. */
const definitions = {
  trust: { title: /Accessing workspace:/, yes: /^❯\s+Yes, I trust this folder$/, no: /^❯\s+No, exit$/, key: "\x1b[B" },
  key: { title: /Do you want to use this API key\?/, yes: /^❯\s+Yes$/, no: /^❯\s+No \(recommended\)$/, key: "\x1b[A" },
};

// Launches authenticate with ANTHROPIC_AUTH_TOKEN (Bearer) and a blank API key, as
// production does, so a key dialog means the CLI found a key the verifier never set.
export function loopbackKeySettings(settings) {
  const key = settings?.env?.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || !key.trim()) throw new Error("Refusing API key confirmation: no ANTHROPIC_API_KEY is configured");
  const raw = settings?.env?.ANTHROPIC_BASE_URL;
  let url;
  try { url = new URL(raw); } catch { throw new Error("Refusing API key confirmation without a private loopback endpoint"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      raw !== url.origin || url.username || url.password || url.search || url.hash) {
    throw new Error("Refusing API key confirmation outside the private loopback bridge");
  }
}

export function startupDialog(screen) {
  const lines = screen.split("\n").map(line => line.trim());
  for (const [kind, definition] of Object.entries(definitions)) {
    if (!definition.title.test(screen)) continue;
    const yes = lines.some(line => definition.yes.test(line));
    const no = lines.some(line => definition.no.test(line));
    const start = lines.findIndex(line => line.startsWith("Accessing workspace:"));
    let displayedWorkspace = "";
    if (kind === "trust") {
      const tail = lines.slice(start + 1);
      while (tail[0] === "") tail.shift();
      displayedWorkspace = tail.slice(0, tail.indexOf("") < 0 ? tail.length : tail.indexOf("")).join("");
    }
    return { kind, selected: yes === no ? null : yes ? "yes" : "no", displayedWorkspace };
  }
  return null;
}

/** Exactly one selection (if needed), one confirmation, then dismissal. */
export class StartupDialogs {
  constructor({ workspace, settings, validateWorkspace = () => {} }) {
    this.workspace = workspace;
    this.settings = settings;
    this.validateWorkspace = validateWorkspace;
    this.states = new Map();
  }

  // Observe every completed render, including frames between polling ticks.
  // Observation never sends a key or advances a confirmation.
  observe({ screen, renderSequence, outputSequence }) {
    const dialog = startupDialog(screen), state = this.states.get(dialog?.kind);
    if (!state || !["selecting", "selected"].includes(state.phase) ||
        renderSequence <= state.selectionRender || outputSequence <= state.selectionOutput) return;
    if (dialog.selected === "yes") state.sawYes = true;
    if (state.sawYes && dialog.selected === "no") throw new Error(`Native ${dialog.kind} selection reversed`);
  }

  next({ screen, renderSequence, outputSequence, drained }) {
    this.observe({ screen, renderSequence, outputSequence });
    const dialog = startupDialog(screen);
    for (const [kind, state] of this.states) {
      if (kind === dialog?.kind || state.phase === "dismissed") continue;
      if (!drained) return null;
      if (state.phase !== "confirmed") throw new Error(`Native ${kind} dialog disappeared before confirmation`);
      if (renderSequence <= state.receipt.renderSequence || outputSequence <= state.receipt.writeOutputSequence) return null;
      state.phase = "dismissed";
    }
    if (!dialog) return null;
    if (dialog.kind === "trust") {
      this.validateWorkspace();
      if (dialog.displayedWorkspace !== this.workspace) {
        if (!drained) return null;
        throw new Error("Refusing trust confirmation for a different workspace");
      }
    } else loopbackKeySettings(this.settings);
    let state = this.states.get(dialog.kind);
    if (!state) { state = { phase: "initial", sawYes: false }; this.states.set(dialog.kind, state); }
    if (state.phase === "dismissed") throw new Error(`Native ${dialog.kind} dialog reappeared after dismissal`);
    if (state.phase === "confirmed" || state.phase === "confirming") {
      if (drained && dialog.selected === "no") throw new Error(`Native ${dialog.kind} selection reversed after confirmation`);
      return null;
    }
    if (state.phase === "selecting") return null;
    if (state.phase === "selected") {
      if (renderSequence <= state.receipt.renderSequence || outputSequence <= state.receipt.writeOutputSequence) return null;
      if (dialog.selected === "yes") state.sawYes = true;
      if (state.sawYes && dialog.selected === "no") throw new Error(`Native ${dialog.kind} selection reversed`);
      if (!drained || dialog.selected !== "yes") return null;
    } else {
      if (!drained || !dialog.selected) return null;
      if (dialog.selected === "no") {
        state.phase = "selecting";
        state.selectionRender = renderSequence;
        state.selectionOutput = outputSequence;
        return { kind: "startup-select", purpose: dialog.kind, data: definitions[dialog.kind].key };
      }
    }
    state.phase = "confirming";
    return { kind: "startup-confirm", purpose: dialog.kind, data: "\r" };
  }

  acknowledge(action, receipt) {
    const state = this.states.get(action.purpose);
    const expected = action.kind === "startup-select" ? "selecting" : action.kind === "startup-confirm" ? "confirming" : null;
    if (!expected || state?.phase !== expected || receipt?.accepted !== true ||
        !Number.isSafeInteger(receipt.renderSequence) || !Number.isSafeInteger(receipt.writeOutputSequence)) {
      throw new Error("Invalid native startup input acknowledgment");
    }
    state.receipt = receipt;
    state.phase = action.kind === "startup-select" ? "selected" : "confirmed";
  }

  get dismissed() { return [...this.states.values()].every(state => state.phase === "dismissed"); }
}

export function terminalActivity(screen) {
  const lines = screen.split("\n");
  const interruptible = /\besc to interrupt\b/i.test(screen);
  const spinner = lines.some(line => /^\s*[·✢✳✶✻✽*]\s+\S.*(?:…|\.\.\.)/u.test(line));
  const dialog = Boolean(startupDialog(screen)) || /Select model|Switch model\?|Manage MCP servers/.test(screen);
  const prompt = lines.some(line => /^\s*[❯>]\s*$/u.test(line));
  return { active: interruptible || spinner, interruptible, ready: prompt && !interruptible && !spinner && !dialog };
}

export function interruptionLines(screen) {
  return screen.split("\n").filter(line => /^\s*⎿\s+Interrupted\s*·\s*What should Claude do instead\?\s*$/u.test(line));
}

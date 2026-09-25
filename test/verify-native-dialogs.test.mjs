/** Sanitized terminal frames and monotonic dialog transitions; no installed CLI. */
import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { StartupDialogs, terminalActivity, interruptionLines, loopbackKeySettings } from "../scripts/verify/native-dialogs.mjs";

const workspace = "/private/fixture/workspace";
const settings = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:12345", ANTHROPIC_API_KEY: "synthetic" } };
const trust = yes => `Accessing workspace:\n\n${workspace}\n\nQuick safety check\n${yes ? "  " : "❯ "}No, exit\n${yes ? "❯ " : "  "}Yes, I trust this folder\n`;
const frame = (screen, seq = 1, drained = true) => ({ screen, renderSequence: seq, outputSequence: seq, drained });
const ack = seq => ({ accepted: true, renderSequence: seq, writeOutputSequence: seq });

for (const initialYes of [false, true]) test(`startup sends selection at most once (initial Yes=${initialYes})`, () => {
  const d = new StartupDialogs({ workspace, settings }), actions = [];
  assert.equal(d.next(frame(trust(initialYes), 1, false)), null);
  let action = d.next(frame(trust(initialYes)));
  actions.push(action.kind);
  if (!initialYes) {
    assert.equal(action.data, "\x1b[B");
    assert.equal(d.next(frame(trust(false), 1)), null);
    d.acknowledge(action, ack(1));
    assert.equal(d.next(frame(trust(true), 1)), null);
    assert.equal(d.next(frame(trust(true), 2, false)), null);
    action = d.next(frame(trust(true), 2)); actions.push(action.kind);
  }
  assert.equal(action.data, "\r"); d.acknowledge(action, ack(2));
  assert.equal(d.next(frame(trust(true), 3)), null);
  assert.equal(d.dismissed, false);
  assert.equal(d.next(frame("❯\n", 3)), null); assert.equal(d.dismissed, true);
  assert.deepEqual(actions, initialYes ? ["startup-confirm"] : ["startup-select", "startup-confirm"]);
  assert.throws(() => d.next(frame(trust(false), 4)), /reappeared/);
});

test("intermediate Yes then No renders are observed even before selection acknowledgment", () => {
  const d = new StartupDialogs({ workspace, settings });
  const select = d.next(frame(trust(false), 1));
  d.observe(frame(trust(true), 2, false));
  d.acknowledge(select, ack(1));
  assert.throws(() => d.observe(frame(trust(false), 3, false)), /selection reversed/);
});

test("selection reversal after confirmation fails without another key", () => {
  const d = new StartupDialogs({ workspace, settings });
  const action = d.next(frame(trust(true))); d.acknowledge(action, ack(1));
  assert.throws(() => d.next(frame(trust(false), 2)), /reversed/);
});

test("startup rejects different workspace, unacknowledged keys and premature dismissal", () => {
  const d = new StartupDialogs({ workspace, settings });
  assert.throws(() => d.next(frame(trust(false).replace(workspace, workspace + "-other"))), /different workspace/);
  const action = d.next(frame(trust(false)));
  assert.throws(() => d.acknowledge(action, { accepted: false }), /acknowledgment/);
  assert.throws(() => d.next(frame("❯\n", 2)), /before confirmation/);
});

for (const endpoint of ["https://127.0.0.1:12", "http://example.com:12", "http://127.0.0.1:12/path", "http://user@127.0.0.1:12"]) {
  test(`API key dialog rejects ${endpoint}`, () => {
    assert.throws(() => loopbackKeySettings({ env: { ...settings.env, ANTHROPIC_BASE_URL: endpoint } }), /Refusing/);
  });
}

test("API key dialog fails closed under production Bearer settings", () => {
  const bearer = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:12345", ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_API_KEY: "" } };
  assert.throws(() => loopbackKeySettings(bearer), /no ANTHROPIC_API_KEY is configured/);
  assert.throws(() => loopbackKeySettings({ env: { ...bearer.env, ANTHROPIC_API_KEY: undefined } }), /no ANTHROPIC_API_KEY/);
  const d = new StartupDialogs({ workspace, settings: bearer });
  for (const selected of ["  Yes\n❯ No (recommended)", "❯ Yes\n  No (recommended)"]) {
    assert.throws(() => d.next(frame(`Do you want to use this API key?\n${selected}`)), /no ANTHROPIC_API_KEY/);
  }
  assert.equal(d.states.size, 0, "no key is selected or confirmed");
});

test("API key dialog selects Yes upward and does not confirm stale frames", () => {
  const d = new StartupDialogs({ workspace, settings });
  const no = "Do you want to use this API key?\n  Yes\n❯ No (recommended)";
  const yes = "Do you want to use this API key?\n❯ Yes\n  No (recommended)";
  const action = d.next(frame(no)); assert.equal(action.data, "\x1b[A"); d.acknowledge(action, ack(1));
  assert.equal(d.next(frame(yes, 1)), null);
  assert.equal(d.next(frame(yes, 2)).kind, "startup-confirm");
});

for (const split of [1, 17, 4096]) test(`ANSI replay preserves startup state across chunks of ${split} bytes`, async () => {
  const terminal = new xterm.Terminal({ cols: 160, rows: 48, allowProposedApi: true });
  const replies = []; terminal.onData(data => replies.push(data));
  try {
    let seq = 0;
    const d = new StartupDialogs({ workspace, settings });
    const screen = () => Array.from({ length: 48 }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
    const render = async text => {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += split) {
        await new Promise(resolve => terminal.write(bytes.subarray(i, i + split), resolve)); seq++;
        assert.equal(d.next(frame(screen(), seq, false)), null);
      }
    };
    await render("\x1b[2J\x1b[H" + trust(false).replaceAll("\n", "\r\n") + "\x1b[6n");
    assert.ok(replies.length > 0);
    const select = d.next(frame(screen(), seq)); assert.equal(select.kind, "startup-select"); d.acknowledge(select, ack(seq));
    await render("\x1b[2J\x1b[H" + trust(true).replaceAll("\n", "\r\n"));
    const confirm = d.next(frame(screen(), seq)); assert.equal(confirm.kind, "startup-confirm"); d.acknowledge(confirm, ack(seq));
    await render("\x1b[2J\x1b[H❯\r\n");
    d.next(frame(screen(), seq)); assert.equal(d.dismissed, true);
  } finally { terminal.dispose(); }
});

test("an input prompt below a spinner is not idle, and prose is not an interruption", () => {
  assert.equal(terminalActivity("✻ Thinking…\n❯\nesc to interrupt").ready, false);
  assert.equal(terminalActivity("✻ Churned for 2s\n❯\n").ready, true);
  assert.deepEqual(interruptionLines("I was Interrupted\n❯"), []);
  assert.equal(interruptionLines("  ⎿ Interrupted · What should Claude do instead?\n❯").length, 1);
});

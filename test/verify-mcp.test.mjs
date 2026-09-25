/** The real stdio fixture, without a model, CLI or network connection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sanitizeEnv } from "../scripts/verify/session.mjs";

const FIXTURE = fileURLToPath(new URL("../scripts/verify/mcp-fixture.mjs", import.meta.url));

test("stdio MCP exposes only lookup, records error before success, and exits on EOF", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const valueFile = path.join(dir, "value.txt"), ledgerFile = path.join(dir, "ledger.jsonl");
  const value = "SYNTHETIC_PRIVATE_SAMPLE";
  fs.writeFileSync(valueFile, value, { mode: 0o600 });
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "lookup", arguments: { key: "missing" } } },
    { id: 4, method: "tools/call", params: { name: "lookup", arguments: { key: "selected" } } },
  ].map(r => ({ jsonrpc: "2.0", ...r }));
  const process = spawnSync(globalThis.process.execPath, [FIXTURE, valueFile, ledgerFile], {
    input: requests.map(r => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8", timeout: 5000, env: sanitizeEnv(),
  });
  assert.equal(process.status, 0, process.stderr);
  assert.equal(process.signal, null);
  assert.equal(process.error, undefined);
  const responses = process.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(responses.map(r => r.id), [1, 2, 3, 4]);
  assert.deepEqual(responses[1].result.tools.map(t => t.name), ["lookup"]);
  assert.equal(JSON.stringify(responses.slice(0, 3)).includes(value), false);
  assert.equal(responses[2].result.isError, true);
  assert.match(responses[2].result.content[0].text, /ENOENT/);
  assert.equal(responses[3].result.isError, false);
  assert.equal(responses[3].result.content[0].text, value);
  const ledger = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").map(JSON.parse);
  const calls = ledger.filter(r => r.method === "tools/call");
  assert.deepEqual(calls.map(r => [r.event, r.id]), [["request", 3], ["response", 3], ["request", 4], ["response", 4]]);
  assert.ok(ledger.every(r => Number.isInteger(r.pid) && r.pid > 0));
  assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o600);
});

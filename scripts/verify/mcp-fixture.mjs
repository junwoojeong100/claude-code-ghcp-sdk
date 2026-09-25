/** Case-owned stdio MCP: one expected error, one hidden value, append-only ledger. */
import fs from "node:fs";
import readline from "node:readline";
const [valuePath, ledgerPath] = process.argv.slice(2);
if (!valuePath || !ledgerPath) throw new Error("Expected private value and ledger paths");
const value = fs.readFileSync(valuePath, "utf8");
const record = row => fs.appendFileSync(ledgerPath, JSON.stringify({ ...row, pid: process.pid }) + "\n", { mode: 0o600 });
const reply = (request, result) => {
  record({ event: "response", id: request.id, method: request.method, result });
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  record({ event: "request", id: request.id, method: request.method, params: request.params });
  if (request.id == null) return;
  if (request.method === "initialize") return reply(request, {
    protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" },
  });
  if (request.method === "ping") return reply(request, {});
  if (request.method === "tools/list") return reply(request, { tools: [{ name: "lookup", description: "Look up a synthetic fixture value by key.",
    inputSchema: { type: "object", properties: { key: { type: "string", enum: ["missing", "selected"] } }, required: ["key"], additionalProperties: false } }] });
  if (request.method === "tools/call") {
    const selected = request.params?.name === "lookup" && request.params?.arguments?.key === "selected";
    return reply(request, { isError: !selected, content: [{ type: "text", text: selected ? value : "ENOENT: synthetic key not found" }] });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n");
});

import readline from "node:readline";

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      capabilities: { tools: {} },
      protocolVersion: "2024-11-05",
      serverInfo: { name: "ghcp-e2e", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: Array.from({ length: 35 }, (_, index) => ({
        name: `echo_${index}`,
        description: `Returns deterministic E2E marker ${index}`,
        inputSchema: { type: "object", properties: {} },
      })),
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, {
      content: [
        {
          type: "text",
          text:
            message.params?.name === "echo_34"
              ? "MCP_E2E_OK"
              : "MCP_WRONG_TOOL",
        },
      ],
    });
    return;
  }
  if (message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      })}\n`,
    );
  }
});

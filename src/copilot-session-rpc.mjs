function rpcMethod(session, path) {
  let value = session?.rpc;
  for (const segment of path) value = value?.[segment];
  return typeof value === "function" ? value : null;
}

export async function submitToolResult(session, request, { toolCallId } = {}) {
  const method = rpcMethod(session, ["tools", "handlePendingToolCall"]);
  if (!method) {
    throw new Error(
      "The installed Copilot SDK does not expose pending tool result handling.",
    );
  }
  const response = await method(request);
  if (response?.success === false) {
    throw new Error(
      toolCallId
        ? `GitHub Copilot rejected the result for tool call ${toolCallId}.`
        : "GitHub Copilot rejected the pending tool result.",
    );
  }
  return response;
}

export async function abortSession(session) {
  if (typeof session?.abort === "function") {
    await session.abort();
  }
}

export async function disconnectSession(session) {
  if (typeof session?.disconnect === "function") {
    await session.disconnect();
  }
}

export async function deleteClientSession(client, sessionId) {
  if (typeof client?.deleteSession === "function") {
    await client.deleteSession(sessionId);
  }
}

export async function getSessionUsage(session) {
  const method = rpcMethod(session, ["usage", "getMetrics"]);
  return method ? method() : null;
}

export async function compactSessionHistory(session, options) {
  const method = rpcMethod(session, ["history", "compact"]);
  if (!method) return null;
  return options === undefined ? method() : method(options);
}

export async function rewindSessionHistory(session, options) {
  const method = rpcMethod(session, ["history", "rewind"]);
  return method ? method(options) : null;
}

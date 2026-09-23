export class BridgeRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

function appendSystemInstruction(system, instruction) {
  if (!instruction) return system;
  if (typeof system === "string") {
    return [
      { type: "text", text: system },
      { type: "text", text: instruction },
    ];
  }
  return [
    ...(Array.isArray(system) ? system : []),
    { type: "text", text: instruction },
  ];
}

function applyToolChoice(body) {
  const choice = body.tool_choice;
  if (!choice || choice.type === "auto") return body;

  const tools = body.tools || [];
  if (choice.type === "none") {
    return { ...body, tools: [] };
  }
  if (choice.type === "any") {
    if (!tools.length) {
      throw new BridgeRequestError(
        "tool_choice requires at least one declared tool.",
      );
    }
    return {
      ...body,
      system: appendSystemInstruction(
        body.system,
        "You must call at least one available tool before answering.",
      ),
    };
  }
  if (choice.type === "tool" && typeof choice.name === "string") {
    const selected = tools.filter((tool) => tool.name === choice.name);
    if (!selected.length) {
      throw new BridgeRequestError(
        `tool_choice requested unavailable tool "${choice.name}".`,
      );
    }
    return {
      ...body,
      system: appendSystemInstruction(
        body.system,
        `You must call the "${choice.name}" tool before answering.`,
      ),
      tools: selected,
    };
  }

  throw new BridgeRequestError("Unsupported tool_choice mode.");
}

// Sampling controls the Copilot SDK does not expose. GET /health reports these
// lists as they are here, so what it advertises and what the bridge logs
// cannot drift apart.
export const DEGRADED_CONTROLS = Object.freeze([
  "temperature",
  "top_p",
  "max_tokens",
  "stop_sequences",
]);

// Accepted request fields that nothing downstream reads. They get their own
// diagnostic field so `controls` keeps its original meaning for consumers.
// A dotted name is a field nested inside the named object.
export const IGNORED_FIELDS = Object.freeze([
  "thinking",
  "top_k",
  "metadata",
  "service_tier",
  "speed",
  "container",
  "mcp_servers",
  "context_management",
  "output_config.format",
  "output_config.task_budget",
  "tool_choice.disable_parallel_tool_use",
]);

function presentFields(body, names) {
  return names.filter(
    (name) =>
      name.split(".").reduce((value, key) => value?.[key], body) !== undefined,
  );
}

export function applyRequestPolicy(body, onDiagnostic = () => {}) {
  const controls = presentFields(body, DEGRADED_CONTROLS);
  const ignored = presentFields(body, IGNORED_FIELDS);
  if (controls.length || ignored.length) {
    onDiagnostic({
      event: "bridge.degraded_controls",
      controls,
      ...(ignored.length ? { ignoredFields: ignored } : {}),
      semantics: "not_exposed_by_copilot_sdk",
    });
  }

  return applyToolChoice(body);
}


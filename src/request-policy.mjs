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

function degradedControls(body) {
  return [
    ["temperature", body.temperature],
    ["top_p", body.top_p],
    ["max_tokens", body.max_tokens],
    ["stop_sequences", body.stop_sequences],
  ]
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
}

export function applyRequestPolicy(body, onDiagnostic = () => {}) {
  const controls = degradedControls(body);
  if (controls.length) {
    onDiagnostic({
      event: "bridge.degraded_controls",
      controls,
      semantics: "not_exposed_by_copilot_sdk",
    });
  }

  return applyToolChoice(body);
}


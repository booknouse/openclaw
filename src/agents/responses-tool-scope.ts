import type { StreamFn } from "@mariozechner/pi-agent-core";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keep the verified relay inside the tools authorized for this model call. */
export function constrainResponsesTools(payload: unknown, names: ReadonlySet<string>): unknown {
  if (!record(payload)) {
    throw new Error("Invalid Responses payload");
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const allowed = tools
    .filter(
      (tool): tool is Record<string, unknown> =>
        record(tool) &&
        tool.type === "function" &&
        typeof tool.name === "string" &&
        names.has(tool.name),
    )
    .map((tool) => ({ type: "function", name: tool.name as string }));
  const available = new Set(allowed.map((tool) => tool.name));
  const choice = payload.tool_choice;
  if (choice === "none") {
    return payload;
  }
  if (record(choice)) {
    if (
      choice.type === "function" &&
      typeof choice.name === "string" &&
      available.has(choice.name)
    ) {
      return payload;
    }
    if (
      choice.type === "allowed_tools" &&
      ["auto", "required"].includes(String(choice.mode)) &&
      Array.isArray(choice.tools) &&
      choice.tools.length > 0 &&
      choice.tools.every(
        (tool) =>
          record(tool) &&
          tool.type === "function" &&
          typeof tool.name === "string" &&
          available.has(tool.name),
      )
    ) {
      return payload;
    }
    throw new Error("Responses tool choice exceeds the current authorized tools");
  }
  if (choice !== undefined && choice !== "auto" && choice !== "required") {
    throw new Error("Unsupported Responses tool choice");
  }
  if (!allowed.length && choice === "required") {
    throw new Error("No authorized Responses tools available");
  }
  return {
    ...payload,
    tool_choice: allowed.length
      ? { type: "allowed_tools", mode: choice === "required" ? "required" : "auto", tools: allowed }
      : "none",
  };
}

export function wrapStreamWithResponsesToolScope(inner: StreamFn): StreamFn {
  return (model, context, options) => {
    // Other providers may not implement allowed_tools. Scope this compatibility
    // adapter to the relay verified by the integration probes.
    if (model.api !== "openai-responses" || model.provider !== "ddww") {
      return inner(model, context, options);
    }
    const names = new Set((context.tools ?? []).map((tool) => tool.name));
    const previous = options?.onPayload;
    return inner(model, context, {
      ...options,
      onPayload: async (payload, currentModel) => {
        const replacement = await previous?.(payload, currentModel);
        return constrainResponsesTools(replacement ?? payload, names);
      },
    });
  };
}

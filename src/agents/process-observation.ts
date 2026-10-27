import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/process");

// Identifiers and counters only: never log command text, stdout or credentials.
export function observeProcess(event: string, fields: Record<string, unknown>) {
  log.info(event, { event, ...fields });
}

const observedMessages = new WeakSet<AssistantMessage>();
export function observeProcessPollUsage(
  message: AssistantMessage,
  runId: string,
  sessionKey?: string,
) {
  if (!message.usage || observedMessages.has(message)) {
    return;
  }
  const calls = message.content.filter((block) => block.type === "toolCall");
  if (
    !calls.length ||
    !calls.every((call) => call.name === "process" && call.arguments.action === "poll")
  ) {
    return;
  }
  observedMessages.add(message);
  observeProcess("process.poll.model_usage", {
    runId,
    sessionKey,
    toolCallIds: calls.map((call) => call.id),
    provider: message.provider,
    model: message.model,
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    total: message.usage.totalTokens,
  });
}

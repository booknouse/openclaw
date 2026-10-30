import { createHash } from "node:crypto";
import { isRecord } from "../utils.js";
import { parseCostTaskResult } from "./cost-task-protocol.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REMOTE_TOOLS = new Set([
  "remote_run",
  "remote_task",
  "remote_task_result",
  "exec",
  "process",
]);
const PENDING = new Set(["running", "pending", "queued", "accepted", "in_progress"]);
const TERMINAL = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "terminated",
  "killed",
  "timeout",
]);

function operationId(value: Record<string, unknown>): string | undefined {
  for (const key of ["background_task_id", "task_id", "taskId", "sessionId"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }
  return undefined;
}
function resultState(value: unknown, depth = 0): { id?: string; pending: boolean } | undefined {
  if (!isRecord(value) || depth > 3) {
    return undefined;
  }
  const id = operationId(value);
  if (value.needs_result_lookup === true || value.running === true) {
    return { id, pending: true };
  }
  if (typeof value.status === "string") {
    if (PENDING.has(value.status)) {
      return { id, pending: true };
    }
    if (TERMINAL.has(value.status)) {
      return { id, pending: false };
    }
  }
  if (typeof value.exit_code === "number" || typeof value.exitCode === "number") {
    return { id, pending: false };
  }
  for (const key of ["details", "result"]) {
    const nested = resultState(value[key], depth + 1);
    if (nested) {
      return { ...nested, id: nested.id ?? id };
    }
  }
  return undefined;
}

/** Unknown or still-running tool work must never be resubmitted automatically. */
export function hasUnsettledCostTools(messages: unknown[]): boolean {
  if (messages.length === 0) {
    return true;
  }
  const outstanding = new Map<string, { name: string; operationId?: string }>();
  const operations = new Map<string, boolean>();
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    if (isRecord(message.__openclaw) && message.__openclaw.truncated === true) {
      return true;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "assistant") {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") {
          continue;
        }
        if (typeof block.name !== "string") {
          return true;
        }
        const args = isRecord(block.arguments) ? block.arguments : {};
        outstanding.set(block.id, { name: block.name, operationId: operationId(args) });
      }
    }
    if (message.role !== "toolResult" && message.role !== "tool") {
      continue;
    }
    const callId = message.toolCallId ?? message.tool_call_id;
    if (typeof callId !== "string" || !callId) {
      return true;
    }
    const call = outstanding.get(callId);
    outstanding.delete(callId);
    const name = message.toolName ?? message.name ?? call?.name;
    if (typeof name !== "string" || !name) {
      return true;
    }
    if (!REMOTE_TOOLS.has(name)) {
      continue;
    }
    let state = resultState(message.details);
    if (!state) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
          continue;
        }
        try {
          state = resultState(JSON.parse(block.text));
        } catch {
          /* Not a structured operational result. */
        }
        if (state) {
          break;
        }
      }
    }
    operations.set(state?.id ?? call?.operationId ?? callId, state?.pending ?? true);
  }
  return outstanding.size > 0 || [...operations.values()].some(Boolean);
}

function eligible(entry: SubagentRunRecord, now: number): boolean {
  const state = entry.costTask;
  const receipt = parseCostTaskResult(entry.frozenResultText ?? "").receipt;
  return (
    !!state &&
    typeof state.systemPrompt === "string" &&
    state.systemPrompt.trim().length > 0 &&
    typeof state.sessionId === "string" &&
    state.sessionId.length > 0 &&
    typeof state.requesterSessionId === "string" &&
    state.requesterSessionId.length > 0 &&
    Number.isFinite(state.deadlineAt) &&
    state.deadlineAt - now >= 1000 &&
    state.continuations === 0 &&
    !state.cancelled &&
    !entry.suppressAnnounceReason &&
    !entry.cleanupCompletedAt &&
    entry.outcome?.status === "ok" &&
    receipt?.status === "partial" &&
    receipt.safeToResume &&
    receipt.blocker === null &&
    receipt.pendingRemoteTasks.length === 0
  );
}

export const COST_CONTINUATION_MESSAGE = [
  "[Cost task continuation] This is the single permitted continuation of the same authorized task, on the same model and transcript, inside the original deadline.",
  "The prior run reported partial work with no blocker or pending remote operations. Inspect the existing state, preserve completed changes, and implement only remaining authorized work. Do not replay completed commands or resubmit existing remote tasks. Do not expand permissions or create a new task scope.",
  "Complete checks and return a concise result with the same cost_task_result receipt. If a real blocker appears, report it. No further automatic continuation is available.",
].join("\n");

export async function continueCostTaskOnce(params: {
  entry: SubagentRunRecord;
  now: () => number;
  isCurrent: () => boolean;
  inspect: () => Promise<boolean>;
  reserve: (runId: string, remainingSeconds: number) => boolean;
  dispatch: (
    runId: string,
    remainingSeconds: number,
    message: string,
  ) => Promise<{ runId?: string }>;
  isAllowed: (runId: string) => boolean;
  confirmed: (runId: string) => void;
  cancelled: (runId: string) => Promise<void>;
  failed: (runId: string) => Promise<void>;
}): Promise<boolean> {
  if (!params.isCurrent() || !eligible(params.entry, params.now())) {
    return false;
  }
  try {
    if (!(await params.inspect())) {
      return false;
    }
  } catch {
    return false;
  }
  if (!params.isCurrent() || !eligible(params.entry, params.now())) {
    return false;
  }
  const remainingSeconds = Math.floor((params.entry.costTask!.deadlineAt - params.now()) / 1000);
  if (remainingSeconds < 1) {
    return false;
  }
  const runId = `cost-continuation:${createHash("sha256").update(params.entry.runId).digest("hex")}`;
  // Reserve durably before dispatch so duplicate completion events and restarts cannot replay it.
  try {
    if (!params.reserve(runId, remainingSeconds)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const response = await params.dispatch(runId, remainingSeconds, COST_CONTINUATION_MESSAGE);
    if (response.runId !== runId) {
      throw new Error("Continuation dispatch not confirmed");
    }
    if (!params.isAllowed(runId)) {
      await params.cancelled(runId);
    } else {
      params.confirmed(runId);
    }
  } catch {
    await params.failed(runId);
  }
  return true;
}

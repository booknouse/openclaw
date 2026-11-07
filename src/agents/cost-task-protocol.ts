import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "../utils.js";
import type { AnyAgentTool } from "./tools/common.js";

export type CostTaskState = {
  deadlineAt: number;
  continuations: number;
  systemPrompt?: string;
  thinking?: string;
  sessionId?: string;
  requesterSessionId?: string;
  cancelled?: boolean;
  dispatchUnconfirmed?: boolean;
};
export type CostImplementationRecovery = { kind: "implementation"; alternative: string };
export type CostTaskReceipt = {
  status: "completed" | "partial" | "blocked";
  remaining: string[];
  blocker: string | null;
  pendingRemoteTasks: string[];
  safeToResume: boolean;
  recovery?: CostImplementationRecovery;
};
type CostSpawnContext = {
  requesterSessionKey: string;
  agentId: string;
  onChildSession?: (key: string) => void;
};
const costSpawnContext = new AsyncLocalStorage<CostSpawnContext>();
export const COST_CONTINUATION_SOURCE = "cost_task_continuation";
export function ensureCostContinuationAllowed(allowed?: () => boolean): void {
  if (allowed && !allowed()) {
    throw new DOMException(
      "Cost task continuation was cancelled or is no longer active",
      "AbortError",
    );
  }
}
export function guardCostContinuationTools(
  tools: AnyAgentTool[],
  allowed?: () => boolean,
): AnyAgentTool[] {
  return allowed
    ? tools.map((tool) => ({
        ...tool,
        execute: (id, args, signal, update) => {
          ensureCostContinuationAllowed(allowed);
          signal?.throwIfAborted();
          return tool.execute(id, args, signal, update);
        },
      }))
    : tools;
}
const OPEN = "<cost_task_result>";
const CLOSE = "</cost_task_result>";

export function withCostTaskSpawnContext<T>(context: CostSpawnContext, run: () => T): T {
  return costSpawnContext.run(context, run);
}
export function getCostTaskSpawnContext(): CostSpawnContext | undefined {
  return costSpawnContext.getStore();
}
function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)
  );
}
export function parseCostTaskResult(reply: string): { text: string; receipt?: CostTaskReceipt } {
  const trimmed = reply.trim();
  const start = trimmed.indexOf(OPEN);
  if (start < 0 || start !== trimmed.lastIndexOf(OPEN) || !trimmed.endsWith(CLOSE)) {
    return { text: trimmed };
  }
  const raw = trimmed.slice(start + OPEN.length, -CLOSE.length);
  if (raw.length > 4096) {
    return { text: trimmed };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "status",
            "remaining",
            "blocker",
            "pendingRemoteTasks",
            "safeToResume",
            "recovery",
          ].includes(key),
      ) ||
      (Object.keys(value).length !== 5 && Object.keys(value).length !== 6) ||
      !["completed", "partial", "blocked"].includes(String(value.status)) ||
      !stringList(value.remaining) ||
      !stringList(value.pendingRemoteTasks) ||
      !(
        value.blocker === null ||
        (typeof value.blocker === "string" &&
          value.blocker.trim().length > 0 &&
          value.blocker.length <= 400)
      ) ||
      typeof value.safeToResume !== "boolean"
    ) {
      return { text: trimmed };
    }
    if (
      value.recovery !== undefined &&
      (!isRecord(value.recovery) ||
        Object.keys(value.recovery).length !== 2 ||
        value.recovery.kind !== "implementation" ||
        typeof value.recovery.alternative !== "string" ||
        !value.recovery.alternative.trim() ||
        value.recovery.alternative.length > 400 ||
        value.status !== "blocked")
    ) {
      return { text: trimmed };
    }
    if (
      value.status === "completed" &&
      (value.remaining.length > 0 || value.pendingRemoteTasks.length > 0 || value.blocker !== null)
    ) {
      return { text: trimmed };
    }
    if (value.status === "partial" && value.remaining.length === 0) {
      return { text: trimmed };
    }
    if (value.status === "blocked" && value.blocker === null) {
      return { text: trimmed };
    }
    return { text: trimmed.slice(0, start).trim(), receipt: value as CostTaskReceipt };
  } catch {
    return { text: trimmed };
  }
}
export function costTaskStatusLabel(receipt?: CostTaskReceipt): string {
  if (!receipt) {
    return "run ended; task completion unverified";
  }
  return receipt.status === "completed"
    ? "worker reports task completed; evidence requires review"
    : `${receipt.status}; task not completed`;
}
export const COST_TASK_RECEIPT_PROMPT = [
  "Complete the authorized goal and checks; a command or backup alone is not completion. Continue remaining work within the original budget, not just a plan.",
  "After the final report append one <cost_task_result> JSON object with status (completed|partial|blocked), remaining (array), blocker (string|null), pendingRemoteTasks (array), safeToResume (boolean), then </cost_task_result>.",
  "Completed requires the goal and checks done. Partial lists remaining work. Blocked requires an actual external constraint. List running remote task IDs; never resubmit them. safeToResume=true requires all operations settled and inspection without replaying completed work.",
  "A failed implementation choice is not necessarily an external blocker. Try feasible existing-runtime alternatives within scope; no dependency installation, configuration/permission changes or interpreter/host switching unless already authorized.",
  'If returning blocked after a settled implementation failure with a feasible in-scope alternative, optionally add recovery: {"kind":"implementation","alternative":"brief approach, no commands or credentials"}. Never use this for missing user data/approval, authorization failures, licences, or unknown/running execution. It is a candidate for verification, not new authority.',
].join("\n");

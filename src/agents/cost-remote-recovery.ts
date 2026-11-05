import fs from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { resolveAgentConfig } from "./agent-scope.js";
import type { CostRemoteWait } from "./cost-remote-wait-store.js";
import { costRemoteStore, COST_REMOTE_RESUME_SOURCE } from "./cost-remote-wait.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

function session(key: string): SessionEntry | undefined {
  const cfg = loadConfig();
  const store = loadSessionStore(
    resolveStorePath(cfg.session?.store, { agentId: resolveAgentIdFromSessionKey(key) }),
  );
  return (
    store[key] ??
    Object.entries(store).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1]
  );
}

export function costRemoteOwnerIsCurrent(item: CostRemoteWait): boolean {
  const { owner } = item;
  const cfg = loadConfig();
  const current = session(owner.sessionKey);
  const parent = owner.parentSessionKey ? session(owner.parentSessionKey) : undefined;
  const agent = resolveAgentIdFromSessionKey(owner.parentSessionKey ?? owner.sessionKey);
  const model = current?.modelOverride ?? current?.model;
  const provider = current?.providerOverride ?? current?.modelProvider;
  return (
    owner.deadlineAt > Date.now() &&
    (resolveAgentConfig(cfg, agent)?.modelRouting ?? cfg.agents?.defaults?.modelRouting) ===
      "cost" &&
    current?.sessionId === owner.sessionId &&
    !current?.abortedLastRun &&
    (model?.includes("/") ? model : `${provider}/${model}`) === owner.model &&
    (!owner.parentSessionKey ||
      (parent?.sessionId === owner.parentSessionId && !parent?.abortedLastRun))
  );
}

export async function recoverCostRemoteRun(item: CostRemoteWait): Promise<boolean> {
  const store = costRemoteStore();
  const waits = store.pending(item.owner.runId);
  if (!costRemoteOwnerIsCurrent(item)) {
    for (const wait of waits) {
      wait.state = "cancelled";
      store.save(wait);
    }
    return true;
  }
  // Concurrent tool calls belong to one model turn; resume only when all have settled.
  if (waits.some((wait) => wait.state === "waiting")) {
    return false;
  }
  const { isEmbeddedPiRunActive } = await import("./pi-embedded.js");
  if (isEmbeddedPiRunActive(item.owner.sessionId)) {
    return false;
  }
  // Resume the same logical run. Server execution bindings and parent subscriptions
  // are keyed by this ID; the durable checkpoint gates entry after a process restart.
  const resumeRunId = item.owner.runId;
  const { getCostRemoteOwner } = await import("./subagent-registry-runtime.js");
  const child = item.owner.parentSessionKey
    ? (getCostRemoteOwner(item.owner.runId, item.owner.sessionKey) ??
      getCostRemoteOwner(resumeRunId, item.owner.sessionKey))
    : undefined;
  if (item.owner.parentSessionKey && !child) {
    for (const wait of waits) {
      wait.state = "cancelled";
      store.save(wait);
    }
    return true;
  }
  const lock = await acquireSessionWriteLock({
    sessionFile: item.owner.sessionFile,
    timeoutMs: 1000,
  });
  try {
    if (waits.some((wait) => store.read(wait.id)?.state === "cancelled")) {
      return true;
    }
    if (!fs.existsSync(item.owner.sessionFile)) {
      throw new Error("Cost recovery transcript is unavailable");
    }
    const manager = SessionManager.open(item.owner.sessionFile);
    if (manager.getSessionId() !== item.owner.sessionId) {
      throw new Error("Cost recovery transcript identity changed");
    }
    const branch = manager.getBranch();
    const parentFile = item.owner.parentSessionKey
      ? session(item.owner.parentSessionKey)?.sessionFile
      : undefined;
    const authority = parentFile
      ? [...branch, ...SessionManager.open(parentFile).getBranch()]
      : branch;
    // Never overwrite a newer user turn after a restart. Internal inter-session input is allowed.
    if (
      authority.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.timestamp > item.owner.startedAt &&
          !hasInterSessionUserProvenance(entry.message),
      )
    ) {
      for (const wait of waits) {
        wait.state = "cancelled";
        store.save(wait);
      }
      return true;
    }
    for (const wait of waits) {
      const hasResult = branch.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === wait.toolCallId,
      );
      if (!hasResult) {
        const hasCall = branch.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.content.some(
              (block) => block.type === "toolCall" && block.id === wait.toolCallId,
            ),
        );
        if (!hasCall) {
          throw new Error("Cost recovery tool call is unavailable; command will not be replayed");
        }
        manager.appendMessage({
          role: "toolResult",
          toolCallId: wait.toolCallId,
          toolName: wait.toolName,
          isError: false,
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task_id: wait.taskId,
                status: "result_available",
                needs_result_lookup: true,
                next_step:
                  "Read this existing task with remote_task_result before continuing. Never resubmit the command.",
              }),
            },
          ],
        });
      }
      wait.state = "dispatching";
      wait.resumeRunId = resumeRunId;
      store.save(wait);
    }
  } finally {
    await lock.release();
  }
  if (!costRemoteOwnerIsCurrent(item)) {
    return false;
  }
  const remainingSeconds = Math.max(1, Math.floor((item.owner.deadlineAt - Date.now()) / 1000));
  // Same durable ID on transport retries. Entry into the runner consumes the reservation
  // before any model/tool execution, including after a gateway restart.
  await callGateway({
    method: "agent",
    timeoutMs: 10000,
    params: {
      sessionKey: item.owner.sessionKey,
      idempotencyKey: resumeRunId,
      deliver: false,
      timeout: remainingSeconds,
      extraSystemPrompt: item.owner.extraSystemPrompt,
      thinking: item.owner.thinking,
      message: `Remote operations finished while this cost task was waiting. Read existing results using remote_task_result for ${waits.map((wait) => wait.taskId).join(", ")}, then complete the remaining authorized work and checks. Do not resubmit these commands. This is a continuation of the original task, not new authorization.`,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: item.owner.parentSessionKey ?? item.owner.sessionKey,
        sourceChannel: "internal",
        sourceTool: COST_REMOTE_RESUME_SOURCE,
      },
    },
  });
  return false;
}

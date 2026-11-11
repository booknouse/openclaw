import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  CostRemoteWaitStore,
  type CostRemoteOwner,
  type CostRemoteWait,
} from "./cost-remote-wait-store.js";
import { foregroundRemoteContext } from "./foreground-remote-session.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

// Plugin SDK and agent entrypoints are emitted into different build chunks.
// Waiting ownership and callbacks must be shared across all copies in one process.
const { scope, active, wake, recovering, spawns, aborters } = resolveGlobalSingleton(
  Symbol.for("openclaw.costRemoteWaitState.v1"),
  () => ({
    scope: new AsyncLocalStorage<CostRemoteOwner>(),
    spawns: new Map<string, string>(),
    active: new Set<string>(),
    aborters: new Map<string, (reason: string) => void>(),
    wake: new Map<string, () => void>(),
    recovering: new Map<string, Promise<boolean>>(),
  }),
);
export const COST_REMOTE_RESUME_SOURCE = "cost_remote_resume";
export function markCostRemoteSpawn(runId: string, sessionKey: string): void {
  spawns.set(runId, sessionKey);
  setTimeout(() => spawns.delete(runId), 60000).unref?.();
}
export function hasCostRemoteSpawn(runId: string, sessionKey: string): boolean {
  return spawns.get(runId) === sessionKey;
}

export const costRemoteStore = () =>
  new CostRemoteWaitStore(path.join(resolveStateDir(), "cost-remote-waits"));

export function bindCostRemoteScope<T>(run: () => Promise<T>): () => Promise<T> {
  const owner = scope.getStore();
  return () => (owner ? scope.run(owner, run) : scope.exit(run));
}

export function hasCostRemoteWait(runId: string): boolean {
  return costRemoteStore()
    .pending(runId)
    .some((item) => item.owner.deadlineAt > Date.now());
}

export async function withCostRemoteRun<T>(
  params: RunEmbeddedPiAgentParams,
  enabled: boolean,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled || !params.sessionKey) {
    return scope.exit(run);
  }
  const foreground = foregroundRemoteContext(params.sessionKey, params.config);
  const resumed =
    params.inputProvenance?.sourceTool === COST_REMOTE_RESUME_SOURCE
      ? costRemoteStore()
          .pending()
          .filter((item) => item.resumeRunId === params.runId)
      : [];
  if (params.inputProvenance?.sourceTool === COST_REMOTE_RESUME_SOURCE) {
    const { costRemoteOwnerIsCurrent } = await import("./cost-remote-recovery.js");
    if (
      !resumed.length ||
      resumed.some(
        (item) =>
          item.owner.sessionKey !== params.sessionKey ||
          item.owner.sessionId !== params.sessionId ||
          !costRemoteOwnerIsCurrent(item),
      )
    ) {
      throw new Error("Cost remote recovery is no longer authorized");
    }
    if (resumed[0].owner.parentSessionKey) {
      // Run this in the agent entrypoint, not the plugin SDK's registry bundle.
      const registry = await import("./subagent-registry-runtime.js");
      const child = resumed[0].owner.routingIndependent
        ? registry.getForegroundRemoteOwner(params.runId, params.sessionKey)
        : registry.getCostRemoteOwner(params.runId, params.sessionKey);
      if (
        !child ||
        !registry.replaceSubagentRunAfterSteer({
          previousRunId: params.runId,
          nextRunId: params.runId,
          runTimeoutSeconds: Math.max(
            1,
            Math.floor((resumed[0].owner.deadlineAt - Date.now()) / 1000),
          ),
          costTask: child.costTask,
          requirePersistence: true,
        })
      ) {
        throw new Error("Cost recovery could not preserve the original child registration");
      }
    }
    Object.assign(params, resumed[0].owner.executionPolicy);
    for (const item of resumed) {
      item.state = "consumed";
      costRemoteStore().save(item);
    }
  }
  const owner: CostRemoteOwner = {
    routingIndependent: !!foreground,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    agentId: params.agentId ?? params.sessionKey.split(":")[1],
    model: `${params.provider}/${params.model}`,
    startedAt: Date.now(),
    deadlineAt: Math.min(
      Date.now() + params.timeoutMs,
      ...resumed.map((item) => item.owner.deadlineAt),
    ),
    extraSystemPrompt: params.extraSystemPrompt,
    thinking: params.thinkLevel,
    executionPolicy: {
      senderIsOwner: params.senderIsOwner === true,
      execOverrides: params.execOverrides,
      bashElevated: params.bashElevated,
      disableMessageTool: params.disableMessageTool,
      requireExplicitMessageTarget: params.requireExplicitMessageTarget,
      spawnedBy: params.spawnedBy,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
    },
  };
  const registry = await import("./subagent-registry-runtime.js");
  const getOwner = foreground?.parentSessionKey
    ? registry.getForegroundRemoteOwner
    : registry.getCostRemoteOwner;
  let child = getOwner(params.runId, params.sessionKey);
  if (
    !child &&
    (foreground?.parentSessionKey || hasCostRemoteSpawn(params.runId, params.sessionKey))
  ) {
    const registrationDeadline = Math.min(owner.deadlineAt, Date.now() + 10000);
    while (!child && Date.now() < registrationDeadline) {
      params.abortSignal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 25));
      child = getOwner(params.runId, params.sessionKey);
    }
    if (!child) {
      throw new Error("Cost child registration was not confirmed; execution was not started");
    }
  }
  if (child) {
    owner.parentSessionKey = child.requesterSessionKey;
    owner.parentSessionId = child.costTask?.requesterSessionId ?? foreground?.parentSessionId;
    owner.deadlineAt = Math.min(owner.deadlineAt, child.costTask?.deadlineAt ?? owner.deadlineAt);
  }
  const originalSignal = params.abortSignal;
  const cancellation = new AbortController();
  params.abortSignal = originalSignal
    ? AbortSignal.any([originalSignal, cancellation.signal])
    : cancellation.signal;
  aborters.set(owner.runId, (reason) => cancellation.abort(new Error(reason)));
  const deadlineTimer = setTimeout(
    () => cancellation.abort(new Error("Cost task deadline reached")),
    Math.max(1, owner.deadlineAt - Date.now()),
  );
  active.add(owner.runId);
  try {
    return await scope.run(owner, run);
  } finally {
    clearTimeout(deadlineTimer);
    active.delete(owner.runId);
    aborters.delete(owner.runId);
    params.abortSignal = originalSignal;
    // A normal return, cancellation or deadline is not a restart. Never resurrect it.
    for (const item of costRemoteStore().pending(owner.runId)) {
      item.state = "cancelled";
      costRemoteStore().save(item);
      wake.get(item.id)?.();
    }
  }
}

export const costRemoteRuntime = {
  pendingRegistrations() {
    return costRemoteStore()
      .pending()
      .filter((item) => item.state === "waiting" && item.owner.deadlineAt > Date.now())
      .map((item) => ({
        wait_id: item.id,
        task_id: item.taskId,
        run_id: item.owner.runId,
        tool_call_id: item.toolCallId,
        deadline_at: item.owner.deadlineAt,
        session_key: item.owner.sessionKey,
        agent_id: item.owner.agentId,
      }));
  },
  current: () => (scope.getStore() ? { runId: scope.getStore()!.runId } : undefined),
  prepare(params: { taskId: string; toolCallId: string; toolName: string }) {
    const owner = scope.getStore();
    if (!owner || owner.deadlineAt <= Date.now()) {
      throw new Error("No active cost execution");
    }
    const record = costRemoteStore().prepare(
      owner,
      params.taskId,
      params.toolCallId,
      params.toolName,
    );
    return { id: record.id, deadlineAt: owner.deadlineAt };
  },
  async wait(id: string, signal?: AbortSignal): Promise<void> {
    const owner = scope.getStore();
    const record = costRemoteStore().read(id);
    if (!owner || record?.owner.runId !== owner.runId) {
      throw new Error("Cost wait owner mismatch");
    }
    signal?.throwIfAborted();
    if (record.state === "waiting") {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          wake.delete(id);
          signal?.removeEventListener("abort", aborted);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const aborted = () => finish(signal?.reason ?? new Error("Cost wait cancelled"));
        const timer = setTimeout(
          () => {
            // Both timers use the same deadline; their callback ordering is not guaranteed.
            // Stop the runner before returning a tool error that a model could handle.
            aborters.get(owner.runId)?.("Cost task deadline reached");
            finish(
              new Error(
                `Cost task deadline reached; existing task ${record.taskId} was not resubmitted`,
              ),
            );
          },
          Math.max(1, owner.deadlineAt - Date.now()),
        );
        wake.set(id, () => finish());
        signal?.addEventListener("abort", aborted, { once: true });
        // Completion may have arrived before the listener was installed.
        if (costRemoteStore().read(id)?.state !== "waiting") {
          finish();
        }
        if (signal?.aborted) {
          aborted();
        }
      });
    }
    signal?.throwIfAborted();
    if (costRemoteStore().read(id)?.state !== "ready") {
      throw new Error("Cost wait is no longer resumable");
    }
  },
  observe(messages: unknown[], model?: string) {
    const owner = scope.getStore();
    if (!owner) {
      return;
    }
    if (model) {
      owner.model = model;
    }
    for (const item of costRemoteStore().pending(owner.runId)) {
      if (item.state !== "ready") {
        continue;
      }
      const recorded = messages.some((message) => {
        if (!message || typeof message !== "object") {
          return false;
        }
        const value = message as { role?: string; toolCallId?: string };
        return value.role === "toolResult" && value.toolCallId === item.toolCallId;
      });
      if (recorded) {
        item.state = "consumed";
        costRemoteStore().save(item);
      }
    }
  },
  async complete(params: {
    id: string;
    sessionKey: string;
    taskId: string;
    cancelled?: boolean;
  }): Promise<{ acknowledged: boolean }> {
    const store = costRemoteStore();
    const item = store.settle(params.id, params.sessionKey, params.taskId);
    if (params.cancelled && item.state !== "consumed") {
      item.state = "cancelled";
      store.save(item);
    }
    if (item.state === "cancelled") {
      aborters.get(item.owner.runId)?.(
        "Cost task cancelled or expired; remote execution was not replayed",
      );
    }
    if (item.state === "consumed" || item.state === "cancelled") {
      wake.get(item.id)?.();
      return { acknowledged: true };
    }
    if (active.has(item.owner.runId)) {
      wake.get(item.id)?.();
      // Retain outbox delivery until the native transcript contains the result.
      return { acknowledged: false };
    }
    let pending = recovering.get(item.owner.runId);
    if (!pending) {
      pending = recover(item).finally(() => recovering.delete(item.owner.runId));
      recovering.set(item.owner.runId, pending);
    }
    return { acknowledged: await pending };
  },
};

async function recover(item: CostRemoteWait): Promise<boolean> {
  const { recoverCostRemoteRun } = await import("./cost-remote-recovery.js");
  return recoverCostRemoteRun(item);
}

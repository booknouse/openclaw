import { randomUUID } from "node:crypto";
import { emitAgentEvent } from "../infra/agent-events.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Outcome = "succeeded" | "failed" | "cancelled";
type Operation = { startedAt: number; sessionKey?: string };
type RecordState = {
  operations: Map<string, Operation>;
  state: Outcome | "running";
  version: number;
  updatedAt: number;
  operationId: string;
};
const state = resolveGlobalSingleton(Symbol.for("openclaw.compactionStatus"), () => ({
  epoch: randomUUID(),
  version: 0,
  sessions: new Map<string, RecordState>(),
}));

export function getCompactionStatus(sessionId: string) {
  const record = state.sessions.get(sessionId);
  return {
    state: record?.operations.size ? "running" : (record?.state ?? "idle"),
    blocking: Boolean(record?.operations.size),
    operationId: record?.operationId,
    startedAt: record?.operations.size
      ? Math.min(...[...record.operations.values()].map((v) => v.startedAt))
      : undefined,
    updatedAt: record?.updatedAt,
    version: record?.version ?? 0,
    epoch: state.epoch,
  };
}

function announce(sessionId: string, operationId: string, sessionKey?: string) {
  if (!sessionKey) {
    return;
  }
  emitAgentEvent({
    runId: `context:${operationId}`,
    sessionKey,
    stream: "context_status",
    data: { sessionId, compaction: getCompactionStatus(sessionId) },
  });
}

export function beginCompaction(
  sessionId: string,
  sessionKey?: string,
  operationId: string = randomUUID(),
) {
  const record = state.sessions.get(sessionId) ?? {
    operations: new Map<string, Operation>(),
    state: "running" as const,
    version: 0,
    updatedAt: 0,
    operationId,
  };
  record.operations.set(operationId, { startedAt: Date.now(), sessionKey });
  record.state = "running";
  record.version = ++state.version;
  record.updatedAt = Date.now();
  record.operationId = operationId;
  state.sessions.set(sessionId, record);
  // Active locks are never evicted. Finished records are only UI diagnostics.
  for (const [id, candidate] of state.sessions) {
    if (
      !candidate.operations.size &&
      (state.sessions.size > 1024 || Date.now() - candidate.updatedAt > 1800000)
    ) {
      state.sessions.delete(id);
    }
  }
  announce(sessionId, operationId, sessionKey);
  return operationId;
}

export function endCompaction(sessionId: string, operationId: string, outcome: Outcome) {
  const record = state.sessions.get(sessionId);
  const operation = record?.operations.get(operationId);
  if (!record || !operation) {
    return;
  }
  record.operations.delete(operationId);
  record.state = record.operations.size ? "running" : outcome;
  record.operationId = operationId;
  record.version = ++state.version;
  record.updatedAt = Date.now();
  announce(sessionId, operationId, operation.sessionKey);
}

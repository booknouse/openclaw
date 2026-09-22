import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type BackgroundCompactionPreparation = {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  tokensBefore: number;
  previousSummary?: string;
};

export type BackgroundCompactionStatus = {
  state: "idle" | "running" | "ready" | "failed";
  startedAt?: number;
  finishedAt?: number;
  retryAfter?: number;
  reason?: string;
};

export type BackgroundCompactionJob = BackgroundCompactionStatus & {
  sessionId: string;
  sessionKey?: string;
  touchedAt: number;
  controller: AbortController;
  snapshotIds: string[];
  snapshotHash: string;
  preparation: BackgroundCompactionPreparation;
  summary?: string;
  model?: string;
  protectedContext?: string;
  timer?: ReturnType<typeof setTimeout>;
};

// Dist chunks must share jobs with the gateway status and reset handlers.
const STATE_KEY = Symbol.for("openclaw.backgroundCompaction");
type State = { jobs: Map<string, BackgroundCompactionJob>; active: number };
const globalState = globalThis as typeof globalThis & { [STATE_KEY]?: State };
const state = (globalState[STATE_KEY] ??= { jobs: new Map(), active: 0 });
const RETENTION_MS = 30 * 60_000;
const MAX_JOBS = 32;

export function getBackgroundCompactionJob(file: string): BackgroundCompactionJob | undefined {
  const job = state.jobs.get(file);
  if (job) {
    job.touchedAt = Date.now();
  }
  return job;
}

export function getBackgroundCompactionStatus(file: string): BackgroundCompactionStatus {
  const job = state.jobs.get(file);
  if (!job) {
    return { state: "idle" };
  }
  const { state: phase, startedAt, finishedAt, retryAfter, reason } = job;
  return { state: phase, startedAt, finishedAt, retryAfter, reason };
}

export function cancelBackgroundCompaction(file: string): void {
  const job = state.jobs.get(file);
  if (!job) {
    return;
  }
  job.controller.abort();
  if (job.timer) {
    clearTimeout(job.timer);
  }
  state.jobs.delete(file);
}

export function cancelBackgroundCompactionForSession(sessionId: string): void {
  for (const [file, job] of state.jobs) {
    if (job.sessionId === sessionId) {
      cancelBackgroundCompaction(file);
    }
  }
}

export function claimBackgroundCompaction(
  file: string,
  job: BackgroundCompactionJob,
  maxConcurrent: number,
): boolean {
  for (const [key, existing] of state.jobs) {
    if (Date.now() - existing.touchedAt > RETENTION_MS) {
      cancelBackgroundCompaction(key);
    }
  }
  if (
    state.active >= maxConcurrent ||
    (!state.jobs.has(file) && state.jobs.size >= Math.max(MAX_JOBS, maxConcurrent))
  ) {
    return false;
  }
  state.jobs.set(file, job);
  state.active++;
  return true;
}

export function releaseBackgroundCompactionSlot(): void {
  state.active = Math.max(0, state.active - 1);
}

export function cancelBackgroundCompactionForKey(key: string): boolean {
  let cancelled = false;
  for (const [file, job] of state.jobs) {
    if (job.sessionKey === key) {
      cancelBackgroundCompaction(file);
      cancelled = true;
    }
  }
  return cancelled;
}

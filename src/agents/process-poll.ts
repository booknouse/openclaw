import { drainSession, getSession, type ProcessSession } from "./bash-process-registry.js";
import { observeProcess } from "./process-observation.js";

const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];
const states = new WeakMap<ProcessSession, { emptyPolls: number; pending?: PendingPoll }>();
type PollSnapshot = {
  stdout: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null | undefined;
  exitSignal: ProcessSession["exitSignal"];
  aggregated: string;
  retryInMs?: number;
  waitedMs: number;
};
type Waiter = {
  resolve: (value: PollSnapshot & { coalesced: boolean }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  coalesced: boolean;
  toolCallId: string;
};
type PendingPoll = {
  startedAt: number;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Set<Waiter>;
};

function abortError() {
  const error = new Error("Process poll cancelled");
  error.name = "AbortError";
  return error;
}

/** Share one wait/drain per live process; cancellation belongs to each caller. */
export function pollProcess(
  session: ProcessSession,
  requestedWaitMs: number,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<PollSnapshot & { coalesced: boolean }> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  let state = states.get(session);
  if (!state) {
    state = { emptyPolls: 0 };
    states.set(session, state);
  }
  const coalesced = Boolean(state.pending);
  const pending = state.pending ?? {
    startedAt: Date.now(),
    deadline: Date.now() + Math.max(requestedWaitMs, BACKOFF_MS[Math.min(state.emptyPolls, 3)]),
    waiters: new Set<Waiter>(),
  };
  state.pending = pending;
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      coalesced,
      toolCallId,
      cleanup: () => signal?.removeEventListener("abort", cancel),
    };
    const cancel = () => {
      pending.waiters.delete(waiter);
      waiter.cleanup();
      if (!pending.waiters.size) {
        clearTimeout(pending.timer);
        if (state.pending === pending) {
          state.pending = undefined;
        }
      }
      observeProcess("process.poll.cancelled", {
        processId: session.id,
        sessionKey: session.sessionKey,
        toolCallId,
      });
      reject(abortError());
    };
    pending.waiters.add(waiter);
    signal?.addEventListener("abort", cancel, { once: true });
    if (coalesced) {
      return;
    }
    const tick = () => {
      if (!pending.waiters.size) {
        return;
      }
      if (!session.exited && getSession(session.id) !== session) {
        state.pending = undefined;
        for (const w of pending.waiters) {
          w.cleanup();
          w.reject(new Error("Process session was removed"));
        }
        pending.waiters.clear();
        return;
      }
      const hasOutput =
        session.pendingStdout.some((chunk) => chunk.trim()) ||
        session.pendingStderr.some((chunk) => chunk.trim());
      if (!session.exited && !hasOutput && Date.now() < pending.deadline) {
        pending.timer = setTimeout(tick, Math.min(100, pending.deadline - Date.now()));
        return;
      }
      const output = drainSession(session);
      const hasText = Boolean(output.stdout.trim() || output.stderr.trim());
      state.emptyPolls = hasText || session.exited ? 0 : Math.min(state.emptyPolls + 1, 3);
      state.pending = undefined;
      const result: PollSnapshot = {
        ...output,
        exited: session.exited,
        exitCode: session.exitCode,
        exitSignal: session.exitSignal,
        aggregated: session.aggregated,
        retryInMs: session.exited ? undefined : BACKOFF_MS[state.emptyPolls],
        waitedMs: Date.now() - pending.startedAt,
      };
      for (const w of pending.waiters) {
        w.cleanup();
        observeProcess("process.poll.result", {
          processId: session.id,
          sessionKey: session.sessionKey,
          toolCallId: w.toolCallId,
          coalesced: w.coalesced,
          waitedMs: result.waitedMs,
          hasOutput: hasText,
          exited: result.exited,
          retryInMs: result.retryInMs,
        });
        w.resolve({ ...result, coalesced: w.coalesced });
      }
      pending.waiters.clear();
    };
    // Queue the first check so simultaneous callers can share even a ready result.
    pending.timer = setTimeout(tick, 0);
  });
}

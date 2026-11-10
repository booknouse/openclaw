import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  acknowledgeProcessExit,
  listFinishedSessions,
  listRunningSessions,
} from "./bash-process-registry.js";

/** Stop implicitly yielded foreground work without cancelling explicit background jobs. */
export function cancelForegroundExecForSession(sessionKey: string): boolean {
  if (!sessionKey.trim()) {
    return false;
  }
  let cancelled = false;
  for (const session of listRunningSessions()) {
    if (
      session.sessionKey !== sessionKey ||
      !session.backgrounded ||
      !session.cancelOnSessionAbort
    ) {
      continue;
    }
    // Disarm completion before sending a signal: exit must not restart the old task.
    session.notifyOnExit = false;
    acknowledgeProcessExit(session);
    const supervisor = getProcessSupervisor();
    const record = supervisor.getRecord(session.id);
    if (record && record.state !== "exited") {
      supervisor.cancel(session.id, "manual-cancel");
    } else {
      const pid = session.pid ?? session.child?.pid;
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        killProcessTree(pid);
      }
    }
    cancelled = true;
  }
  for (const session of listFinishedSessions()) {
    if (
      session.sessionKey === sessionKey &&
      session.cancelOnSessionAbort &&
      !session.exitObserved
    ) {
      acknowledgeProcessExit(session);
      cancelled = true;
    }
  }
  return cancelled;
}

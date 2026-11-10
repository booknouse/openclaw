import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainSystemEvents, enqueueSystemEvent } from "../infra/system-events.js";
import { killProcessTree } from "../process/kill-tree.js";
import { cancelForegroundExecForSession } from "./bash-process-cancel.js";
import {
  addSession,
  getFinishedSession,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

const supervisor = vi.hoisted(() => ({ getRecord: vi.fn(), cancel: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => supervisor }));
vi.mock("../process/kill-tree.js", () => ({ killProcessTree: vi.fn() }));

function session(id: string, key = "test-session", foreground = true) {
  const value = {
    ...createProcessSessionFixture({ id, backgrounded: true, pid: 12345 }),
    sessionKey: key,
    cancelOnSessionAbort: foreground,
    notifyOnExit: true,
  };
  addSession(value);
  return value;
}

describe("session-scoped foreground exec cancellation", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
    vi.clearAllMocks();
    supervisor.getRecord.mockReturnValue({ state: "running" });
    drainSystemEvents("test-session");
    drainSystemEvents("other-session");
  });

  it("cancels yielded foreground work and disarms its completion wake", () => {
    const value = session("pending");
    expect(cancelForegroundExecForSession("test-session")).toBe(true);
    expect(supervisor.cancel).toHaveBeenCalledWith("pending", "manual-cancel");
    expect(value.notifyOnExit).toBe(false);
    expect(value.exitObserved).toBe(true);
  });

  it("preserves explicit background jobs and other sessions", () => {
    const background = session("background", "test-session", false);
    const other = session("other", "other-session");
    expect(cancelForegroundExecForSession("test-session")).toBe(false);
    expect(supervisor.cancel).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(background.notifyOnExit).toBe(true);
    expect(other.notifyOnExit).toBe(true);
  });

  it("uses the registered pid only when the supervisor no longer has the job", () => {
    supervisor.getRecord.mockReturnValue(undefined);
    session("pending");
    expect(cancelForegroundExecForSession("test-session")).toBe(true);
    expect(killProcessTree).toHaveBeenCalledWith(12345);
  });

  it("discards an already queued completion for the stopped foreground task", () => {
    const value = session("finished");
    markExited(value, 0, null, "completed");
    enqueueSystemEvent("Exec completed", {
      sessionKey: "test-session",
      contextKey: "exec:finished:exit",
    });
    expect(cancelForegroundExecForSession("test-session")).toBe(true);
    expect(drainSystemEvents("test-session")).toEqual([]);
    expect(getFinishedSession("finished")?.exitObserved).toBe(true);
  });
});

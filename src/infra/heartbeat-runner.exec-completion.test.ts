import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setActiveEmbeddedRun, clearActiveEmbeddedRun } from "../agents/pi-embedded-runner/runs.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  runHeartbeatOnce,
  startHeartbeatRunner,
  setHeartbeatsEnabled,
} from "./heartbeat-runner.js";
import { withTempHeartbeatSandbox, seedSessionStore } from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatNow, resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";
import {
  enqueueSystemEvent,
  drainSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

afterEach(() => {
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  resetHeartbeatWakeStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const key = "agent:worker:subagent:completion-test";
const reason = "exec:quiet-task:exit";
const notice = "Exec completed (quiet-ta, code 0) :: done";
function enqueue() {
  enqueueSystemEvent(notice, { sessionKey: key, contextKey: reason });
}

it("wakes a non-periodic agent once in its original existing session and ignores consumed events", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: tmpDir, heartbeat: { every: "0m", target: "none" } },
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
      session: { store: storePath },
    };
    await seedSessionStore(storePath, key, {
      sessionId: "completion-sid",
      lastChannel: "",
      lastProvider: "",
      lastTo: "",
    });
    replySpy.mockImplementation(async (ctx: { SessionKey?: string; Provider?: string }) => {
      expect(ctx.SessionKey).toBe(key);
      expect(ctx.Provider).toBe("exec-event");
      drainSystemEvents(key);
      return { text: "Handled" };
    });
    enqueue();
    expect(
      (await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason })).status,
    ).toBe("ran");
    expect(
      await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason }),
    ).toMatchObject({ status: "skipped", reason: "exec-event-consumed" });
    expect(replySpy).toHaveBeenCalledOnce();
    expect(
      (await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason: "interval" }))
        .status,
    ).toBe("skipped");
  });
});

it("does not recreate a deleted session, cross-route a completion, or ignore explicit global pause", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: tmpDir },
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
      session: { store: storePath },
    };
    await fs.writeFile(storePath, "{}");
    enqueue();
    expect(
      await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason }),
    ).toMatchObject({ reason: "exec-session-unavailable" });
    await seedSessionStore(storePath, key, { lastChannel: "", lastProvider: "", lastTo: "" });
    expect(await runHeartbeatOnce({ cfg, agentId: "main", sessionKey: key, reason })).toMatchObject(
      { reason: "exec-session-unavailable" },
    );
    setHeartbeatsEnabled(false);
    expect(
      await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason }),
    ).toMatchObject({ reason: "disabled" });
    expect(replySpy).not.toHaveBeenCalled();
  });
});

it("defers a completion while the original embedded run is active", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: tmpDir },
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
      session: { store: storePath },
    };
    await seedSessionStore(storePath, key, {
      sessionId: "busy",
      lastChannel: "",
      lastProvider: "",
      lastTo: "",
    });
    enqueue();
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    setActiveEmbeddedRun("busy", handle, key);
    try {
      expect(
        await runHeartbeatOnce({ cfg, agentId: "worker", sessionKey: key, reason }),
      ).toMatchObject({ reason: "requests-in-flight" });
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      clearActiveEmbeddedRun("busy", handle, key);
    }
  });
});

it("dispatches explicit completions when no agents have a periodic schedule and retries busy targets", async () => {
  vi.useFakeTimers();
  const runOnce = vi
    .fn()
    .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
    .mockResolvedValue({ status: "ran", durationMs: 1 });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { heartbeat: { every: "0m" } },
      list: [{ id: "main", default: true }, { id: "worker" }],
    },
  };
  const runner = startHeartbeatRunner({ cfg, runOnce });
  try {
    requestHeartbeatNow({ sessionKey: key, agentId: "worker", reason, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1100);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "worker", sessionKey: key, reason }),
    );
  } finally {
    runner.stop();
  }
});

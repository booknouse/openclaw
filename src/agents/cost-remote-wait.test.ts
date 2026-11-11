import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ directory: "", recover: vi.fn(), child: vi.fn() }));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => mocks.directory }));
vi.mock("./subagent-registry-runtime.js", () => ({
  getCostRemoteOwner: mocks.child,
  getForegroundRemoteOwner: mocks.child,
}));
vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({
    "agent:alice:subagent:plain": {
      sessionId: "session",
      spawnedBy: "agent:alice:tenant:alice:web:fixture:role:user",
    },
    "agent:alice:tenant:alice:web:fixture:role:user": { sessionId: "parent" },
  }),
  resolveStorePath: () => "test-sessions",
}));
vi.mock("./cost-remote-recovery.js", () => ({
  recoverCostRemoteRun: mocks.recover,
  costRemoteOwnerIsCurrent: () => true,
}));
import { CostRemoteWaitStore, type CostRemoteOwner } from "./cost-remote-wait-store.js";
import {
  costRemoteRuntime as runtime,
  costRemoteStore,
  withCostRemoteRun,
  bindCostRemoteScope,
  markCostRemoteSpawn,
} from "./cost-remote-wait.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

function params(): RunEmbeddedPiAgentParams {
  return {
    runId: "run",
    sessionId: "session",
    sessionKey: "agent:alice:main",
    agentId: "alice",
    sessionFile: path.join(mocks.directory, "session.jsonl"),
    workspaceDir: mocks.directory,
    provider: "test",
    model: "model",
    timeoutMs: 60000,
    prompt: "Read, modify, then verify",
  };
}
function owner(): CostRemoteOwner {
  const p = params();
  return {
    runId: p.runId,
    sessionId: p.sessionId,
    sessionKey: p.sessionKey!,
    agentId: "alice",
    sessionFile: p.sessionFile,
    model: "test/model",
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60000,
  };
}
beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), "cost-wait-"));
  mocks.recover.mockReset().mockResolvedValue(false);
  mocks.child.mockReset().mockReturnValue(undefined);
});
afterEach(() => {
  fs.rmSync(mocks.directory, { recursive: true, force: true });
});

describe("cost-only remote execution lifecycle", () => {
  it("aborts the runner even when the waiting tool's timer fires before the owner timer", async () => {
    const p = params();
    await withCostRemoteRun(p, true, async () => {
      const ticket = runtime.prepare({
        taskId: "job",
        toolCallId: "timer-order",
        toolName: "remote_run",
      });
      const original = setTimeout;
      let expire: (() => void) | undefined;
      const timer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          expire = () => callback(...args);
          return original(callback, delay, ...args);
        });
      try {
        const waiting = runtime.wait(ticket.id, p.abortSignal);
        const rejected = expect(waiting).rejects.toThrow(/deadline/);
        timer.mockRestore();
        expect(expire).toBeDefined();
        expire!();
        await rejected;
        expect(p.abortSignal?.aborted).toBe(true);
      } finally {
        timer.mockRestore();
      }
    });
  });

  it("enforces the original deadline while waiting without another model turn", async () => {
    const p = { ...params(), timeoutMs: 100 };
    await withCostRemoteRun(p, true, async () => {
      const ticket = runtime.prepare({
        taskId: "job",
        toolCallId: "deadline-call",
        toolName: "remote_run",
      });
      await expect(runtime.wait(ticket.id, p.abortSignal)).rejects.toThrow(/deadline/);
      expect(p.abortSignal?.aborted).toBe(true);
    });
  });

  it("aborts the execution runner when a durable cancellation arrives, not just the waiting tool", async () => {
    const p = params();
    await withCostRemoteRun(p, true, async () => {
      const ticket = runtime.prepare({ taskId: "job", toolCallId: "call", toolName: "remote_run" });
      const waiting = runtime.wait(ticket.id, p.abortSignal);
      const rejected = expect(waiting).rejects.toThrow(/cancelled/);
      await runtime.complete({
        id: ticket.id,
        sessionKey: p.sessionKey!,
        taskId: "job",
        cancelled: true,
      });
      await rejected;
      expect(p.abortSignal?.aborted).toBe(true);
    });
  });

  it("keeps a fast cost child gated until its original registration is durable", async () => {
    const p = { ...params(), runId: "spawn-race", sessionKey: "agent:alice:subagent:child" };
    markCostRemoteSpawn(p.runId, p.sessionKey);
    mocks.child.mockReturnValueOnce(undefined).mockReturnValue({
      requesterSessionKey: "agent:alice:main",
      costTask: {
        requesterSessionId: "parent",
        deadlineAt: Date.now() + 30000,
        continuations: 0,
      },
    });
    await withCostRemoteRun(p, true, async () => {
      const ticket = runtime.prepare({
        taskId: "read",
        toolCallId: "call",
        toolName: "remote_run",
      });
      expect(costRemoteStore().read(ticket.id)?.owner.parentSessionId).toBe("parent");
    });
  });

  it("retains the correct execution scope when a shared queue invokes it from another context", async () => {
    let execute!: () => Promise<void>;
    const queued = withCostRemoteRun(
      params(),
      true,
      () =>
        new Promise<void>((resolve) => {
          execute = bindCostRemoteScope(async () => {
            expect(runtime.current()?.runId).toBe("run");
            await withCostRemoteRun({ ...params(), runId: "single" }, false, async () => {
              expect(runtime.current()).toBeUndefined();
            });
            expect(runtime.current()?.runId).toBe("run");
            resolve();
          });
        }),
    );
    await vi.waitFor(() => expect(execute).toBeDefined());
    expect(runtime.current()).toBeUndefined();
    await execute();
    await queued;
  });
  it("replays only pending registration metadata after a process restart", () => {
    const item = costRemoteStore().prepare(owner(), "job", "call", "remote_run");
    expect(runtime.pendingRegistrations()).toEqual([
      expect.objectContaining({
        wait_id: item.id,
        run_id: "run",
        tool_call_id: "call",
        task_id: "job",
        session_key: owner().sessionKey,
      }),
    ]);
    expect(JSON.stringify(runtime.pendingRegistrations())).not.toContain("sessionFile");
  });

  it("does not enroll a single-model run or adopt historical tasks", async () => {
    await withCostRemoteRun(params(), false, async () => {
      expect(runtime.current()).toBeUndefined();
      expect(() =>
        runtime.prepare({ taskId: "old", toolCallId: "call", toolName: "remote_run" }),
      ).toThrow();
    });
    expect(fs.readdirSync(mocks.directory)).toEqual([]);
  });
  it("waits through multiple remote steps without ending or consuming a partial retry", async () => {
    await withCostRemoteRun(params(), true, async () => {
      for (const taskId of ["read", "compile", "verify"]) {
        const ticket = runtime.prepare({ taskId, toolCallId: taskId, toolName: "remote_run" });
        let finished = false;
        const waiting = runtime.wait(ticket.id).then(() => {
          finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(
          await runtime.complete({ id: ticket.id, sessionKey: params().sessionKey!, taskId }),
        ).toEqual({ acknowledged: false });
        await waiting;
        runtime.observe([{ role: "toolResult", toolCallId: taskId }]);
        expect(
          await runtime.complete({ id: ticket.id, sessionKey: params().sessionKey!, taskId }),
        ).toEqual({ acknowledged: true });
      }
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("handles terminal-before-wait and duplicate completion", async () => {
    await withCostRemoteRun(params(), true, async () => {
      const ticket = runtime.prepare({ taskId: "job", toolCallId: "call", toolName: "remote_run" });
      const event = { id: ticket.id, sessionKey: params().sessionKey!, taskId: "job" };
      await runtime.complete(event);
      await runtime.complete(event);
      await runtime.wait(ticket.id);
      expect(costRemoteStore().read(ticket.id)?.state).toBe("ready");
    });
  });
  it("cancellation wins over late completion and never dispatches recovery", async () => {
    let id = "";
    await withCostRemoteRun(params(), true, async () => {
      const ticket = runtime.prepare({ taskId: "job", toolCallId: "call", toolName: "remote_run" });
      id = ticket.id;
      const controller = new AbortController();
      const result = runtime.wait(id, controller.signal);
      controller.abort(new Error("User stopped"));
      await expect(result).rejects.toThrow("User stopped");
    });
    expect(await runtime.complete({ id, sessionKey: params().sessionKey!, taskId: "job" })).toEqual(
      { acknowledged: true },
    );
    expect(costRemoteStore().read(id)?.state).toBe("cancelled");
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("rejects completion from another execution or session", async () => {
    const item = costRemoteStore().prepare(owner(), "job", "call", "remote_run");
    await expect(
      runtime.complete({ id: item.id, sessionKey: "agent:bob:main", taskId: "job" }),
    ).rejects.toThrow("does not own");
    await expect(
      runtime.complete({ id: item.id, sessionKey: owner().sessionKey, taskId: "other" }),
    ).rejects.toThrow("does not own");
    expect(costRemoteStore().read(item.id)?.state).toBe("waiting");
  });
  it("restores the durable wait and serializes duplicate restart events", async () => {
    const store = new CostRemoteWaitStore(path.join(mocks.directory, "cost-remote-waits"));
    const item = store.prepare(owner(), "job", "call", "remote_run");
    let release!: (value: boolean) => void;
    mocks.recover.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const event = { id: item.id, sessionKey: item.owner.sessionKey, taskId: item.taskId };
    const first = runtime.complete(event);
    const second = runtime.complete(event);
    await vi.waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(1));
    expect(costRemoteStore().read(item.id)?.state).toBe("ready");
    release(true);
    await expect(first).resolves.toEqual({ acknowledged: true });
    await expect(second).resolves.toEqual({ acknowledged: true });
  });
  it("expires rather than reviving an old task", async () => {
    const item = costRemoteStore().prepare(
      { ...owner(), deadlineAt: Date.now() - 1 },
      "job",
      "call",
      "remote_run",
    );
    await runtime.complete({ id: item.id, sessionKey: item.owner.sessionKey, taskId: item.taskId });
    expect(costRemoteStore().read(item.id)?.state).toBe("cancelled");
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("preserves the original child budget and never treats regular subagents as cost", async () => {
    const deadlineAt = Date.now() + 5000;
    mocks.child.mockReturnValue({
      requesterSessionKey: "agent:alice:main",
      costTask: { requesterSessionId: "parent", deadlineAt, continuations: 1 },
    });
    await withCostRemoteRun(params(), true, async () => {
      const ticket = runtime.prepare({ taskId: "job", toolCallId: "call", toolName: "remote_run" });
      expect(ticket.deadlineAt).toBe(deadlineAt);
      expect(costRemoteStore().read(ticket.id)?.owner.parentSessionId).toBe("parent");
    });
  });
});

it("persists non-cost delegated ownership without manufacturing cost routing metadata", async () => {
  const p = { ...params(), sessionKey: "agent:alice:subagent:plain", config: {} };
  mocks.child.mockReturnValue({
    childSessionKey: p.sessionKey,
    requesterSessionKey: "agent:alice:tenant:alice:web:fixture:role:user",
  });
  await withCostRemoteRun(p, true, async () => {
    const ticket = runtime.prepare({ taskId: "job", toolCallId: "call", toolName: "remote_run" });
    expect(costRemoteStore().read(ticket.id)?.owner).toMatchObject({
      routingIndependent: true,
      parentSessionId: "parent",
      model: "test/model",
    });
    expect(mocks.child.mock.results[0].value.costTask).toBeUndefined();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  directory: "",
  config: { agents: { defaults: { modelRouting: "cost" } } },
  sessions: {} as Record<string, unknown>,
  branch: [] as unknown[],
  append: vi.fn(),
  rpc: vi.fn(),
  active: vi.fn(),
  child: vi.fn(),
  replace: vi.fn(),
  release: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => h.directory }));
vi.mock("../config/config.js", () => ({ loadConfig: () => h.config }));
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => h.sessions,
  resolveStorePath: () => "sessions",
}));
vi.mock("./agent-scope.js", () => ({ resolveAgentConfig: () => undefined }));
vi.mock("../gateway/call.js", () => ({ callGateway: h.rpc }));
vi.mock("./pi-embedded.js", () => ({ isEmbeddedPiRunActive: h.active }));
vi.mock("./subagent-registry-runtime.js", () => ({
  getCostRemoteOwner: h.child,
  replaceSubagentRunAfterSteer: h.replace,
}));
vi.mock("./session-write-lock.js", () => ({ acquireSessionWriteLock: h.lock }));
vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: () => ({
      getBranch: () => h.branch,
      getSessionId: () => "session",
      appendMessage: h.append,
    }),
  },
}));
import { recoverCostRemoteRun } from "./cost-remote-recovery.js";
import {
  costRemoteStore,
  costRemoteRuntime,
  withCostRemoteRun,
  COST_REMOTE_RESUME_SOURCE,
} from "./cost-remote-wait.js";

beforeEach(() => {
  h.directory = fs.mkdtempSync(path.join(os.tmpdir(), "cost-recovery-"));
  h.config.agents.defaults.modelRouting = "cost";
  h.sessions = {
    "agent:alice:main": { sessionId: "session", modelProvider: "test", model: "model" },
  };
  h.branch = [];
  h.append.mockReset().mockImplementation((message) => {
    h.branch.push({ type: "message", message });
  });
  h.rpc.mockReset().mockResolvedValue({ runId: "ignored" });
  h.active.mockReset().mockReturnValue(false);
  h.child.mockReset().mockReturnValue(undefined);
  h.replace.mockReset().mockReturnValue(true);
  h.release.mockReset().mockResolvedValue(undefined);
  h.lock.mockReset().mockResolvedValue({ release: h.release });
});
afterEach(() => {
  fs.rmSync(h.directory, { recursive: true, force: true });
});

function ready() {
  fs.writeFileSync(path.join(h.directory, "transcript.jsonl"), "test transcript");
  h.branch.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "remote_run", arguments: {} }],
    },
  });
  const store = costRemoteStore();
  const item = store.prepare(
    {
      runId: "original",
      sessionKey: "agent:alice:main",
      sessionId: "session",
      sessionFile: path.join(h.directory, "transcript.jsonl"),
      agentId: "alice",
      model: "test/model",
      startedAt: Date.now() - 60000,
      deadlineAt: Date.now() + 60000,
      executionPolicy: { senderIsOwner: false, disableMessageTool: true },
    },
    "remote-job",
    "call",
    "remote_run",
  );
  return store.settle(item.id, item.owner.sessionKey, item.taskId);
}

describe("cost remote recovery dispatch", () => {
  it("resumes the original session with a fixed ID and records missing tool output through SessionManager", async () => {
    const item = ready();
    await recoverCostRemoteRun(item);
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.append.mock.calls[0][0]).toMatchObject({
      role: "toolResult",
      toolCallId: "call",
      toolName: "remote_run",
    });
    expect(h.rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: item.owner.sessionKey,
          idempotencyKey: "original",
          inputProvenance: expect.objectContaining({ sourceTool: COST_REMOTE_RESUME_SOURCE }),
        }),
      }),
    );
    expect(costRemoteStore().read(item.id)?.state).toBe("dispatching");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("retries a lost dispatch confirmation with the same ID without duplicating transcript results", async () => {
    const item = ready();
    h.rpc.mockRejectedValueOnce(new Error("confirmation lost"));
    await expect(recoverCostRemoteRun(item)).rejects.toThrow("confirmation lost");
    await recoverCostRemoteRun(costRemoteStore().read(item.id)!);
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.rpc.mock.calls.map(([request]) => request.params.idempotencyKey)).toEqual([
      "original",
      "original",
    ]);
  });
  it("consumes the durable reservation before executing a recovered primary task and preserves permissions", async () => {
    const item = ready();
    await recoverCostRemoteRun(item);
    const parameters = {
      runId: "original",
      sessionId: "session",
      sessionKey: item.owner.sessionKey,
      sessionFile: item.owner.sessionFile,
      workspaceDir: h.directory,
      provider: "test",
      model: "model",
      prompt: "resume",
      timeoutMs: 120000,
      senderIsOwner: true,
      inputProvenance: { kind: "inter_session" as const, sourceTool: COST_REMOTE_RESUME_SOURCE },
    };
    await withCostRemoteRun(parameters, true, async () => {
      expect(costRemoteStore().read(item.id)?.state).toBe("consumed");
      expect(parameters.senderIsOwner).toBe(false);
      const next = costRemoteRuntime.prepare({
        taskId: "next",
        toolCallId: "next",
        toolName: "remote_run",
      });
      expect(next.deadlineAt).toBe(item.owner.deadlineAt);
    });
    await expect(
      withCostRemoteRun(parameters, true, async () => {
        throw Error("must not execute twice");
      }),
    ).rejects.toThrow("no longer authorized");
  });
  it.each(["cancelled", "new-session", "mode-disabled", "model-changed", "expired"])(
    "rejects %s ownership",
    async (kind) => {
      const item = ready();
      if (kind === "cancelled") {
        h.sessions[item.owner.sessionKey] = { sessionId: "session", abortedLastRun: true };
      }
      if (kind === "new-session") {
        h.sessions[item.owner.sessionKey] = { sessionId: "new" };
      }
      if (kind === "mode-disabled") {
        h.config.agents.defaults.modelRouting = "off";
      }
      if (kind === "model-changed") {
        h.sessions[item.owner.sessionKey] = {
          sessionId: "session",
          model: "other",
          modelProvider: "test",
        };
      }
      if (kind === "expired") {
        item.owner.deadlineAt = Date.now() - 1;
        costRemoteStore().save(item);
      }
      expect(await recoverCostRemoteRun(item)).toBe(true);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(costRemoteStore().read(item.id)?.state).toBe("cancelled");
    },
  );
  it("does not interrupt another live run", async () => {
    const item = ready();
    h.active.mockReturnValue(true);
    expect(await recoverCostRemoteRun(item)).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("waits for all concurrent remote operations", async () => {
    const item = ready();
    costRemoteStore().prepare(item.owner, "second", "second-call", "remote_run");
    expect(await recoverCostRemoteRun(item)).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("does not resume over a newer external user instruction", async () => {
    const item = ready();
    h.branch = [
      {
        type: "message",
        message: { role: "user", content: "Stop and change target", timestamp: Date.now() + 1000 },
      },
    ];
    expect(await recoverCostRemoteRun(item)).toBe(true);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("preserves the original child and does not spend its partial continuation allowance", async () => {
    const item = ready();
    item.owner.parentSessionKey = "agent:alice:parent";
    item.owner.parentSessionId = "parent";
    h.sessions[item.owner.parentSessionKey] = { sessionId: "parent" };
    costRemoteStore().save(item);
    const costTask = { continuations: 1, deadlineAt: item.owner.deadlineAt };
    h.child.mockReturnValue({ runId: "original", costTask });
    await recoverCostRemoteRun(item);
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ idempotencyKey: "original" }) }),
    );
    expect(costTask.continuations).toBe(1);
  });
});

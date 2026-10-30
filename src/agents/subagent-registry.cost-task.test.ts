import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { hasUnsettledCostTools } from "./cost-task-continuation.js";
import { withCostTaskSpawnContext } from "./cost-task-protocol.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const h = vi.hoisted(() => ({
  config: {
    agents: { defaults: { modelRouting: "cost", subagents: { archiveAfterMinutes: 0 } } },
  } as OpenClawConfig,
  sessions: {} as Record<string, SessionEntry>,
  handler: undefined as ((event: AgentEventPayload) => void) | undefined,
  reply: "",
  history: [] as unknown[],
  historyReads: 0,
  failSave: false,
  failDispatch: false,
  onDispatch: (_id: string) => {},
  onHistory: () => {},
  snapshot: new Map<string, SubagentRunRecord>(),
  restored: new Map<string, SubagentRunRecord>(),
  announce: vi.fn(async (_args: unknown) => true),
  gateway: vi.fn(
    async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
      if (request.method === "agent.wait") {
        return new Promise<unknown>(() => {});
      }
      if (request.method === "chat.history") {
        h.onHistory();
        return { messages: h.history };
      }
      if (request.method === "agent") {
        const runId = String(request.params?.idempotencyKey);
        h.onDispatch(runId);
        if (h.failDispatch) {
          throw new Error("dispatch unavailable");
        }
        return { runId };
      }
      return {};
    },
  ),
  save: vi.fn((runs: Map<string, SubagentRunRecord>): void => {
    if (h.failSave) {
      throw new Error("persistence unavailable");
    }
    h.snapshot = new Map([...runs].map(([key, value]) => [key, structuredClone(value)]));
  }),
}));
vi.mock("../gateway/call.js", () => ({ callGateway: h.gateway }));
vi.mock("../config/config.js", () => ({ loadConfig: () => h.config }));
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => h.sessions,
  resolveStorePath: () => "/tmp/cost-task-test-store",
  resolveAgentIdFromSessionKey: (key: string) => key.split(":")[1] ?? "main",
}));
vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (handler: typeof h.handler) => {
    h.handler = handler;
    return () => {};
  },
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: h.announce,
  captureSubagentCompletionReply: async () => h.reply,
}));
vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: () => h.restored,
  saveSubagentRegistryToDisk: h.save,
}));
vi.mock("./pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(() => false),
  isEmbeddedPiRunActive: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));
vi.mock("./cost-task-tool-history.js", () => ({
  costToolsAreSettled: async () => {
    h.historyReads += 1;
    h.onHistory();
    return !hasUnsettledCostTools(h.history);
  },
}));
vi.mock("../context-engine/init.js", () => ({ ensureContextEnginesInitialized: async () => {} }));
vi.mock("../context-engine/registry.js", () => ({ resolveContextEngine: async () => ({}) }));
vi.mock("./runtime-plugins.js", () => ({ ensureRuntimePluginsLoaded: () => {} }));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));

const parent = "agent:main:main";
const child = "agent:main:subagent:cost-test";
const partial =
  'Only backup completed.\n<cost_task_result>{"status":"partial","remaining":["Implement changes"],"blocker":null,"pendingRemoteTasks":[],"safeToResume":true}</cost_task_result>';
describe("cost registry completion integration", () => {
  let registry: typeof import("./subagent-registry.js");
  beforeAll(async () => {
    registry = await import("./subagent-registry.js");
  });
  beforeEach(() => {
    registry.resetSubagentRegistryForTests({ persist: false });
    h.config.agents!.defaults!.modelRouting = "cost";
    h.sessions = {
      [parent]: { sessionId: "parent-session", updatedAt: 1 },
      [child]: {
        sessionId: "child-session",
        updatedAt: 1,
        providerOverride: "provider",
        modelOverride: "primary",
        spawnedBy: parent,
      },
    };
    h.reply = partial;
    h.historyReads = 0;
    h.history = [{ role: "assistant", content: [{ type: "text", text: partial }] }];
    h.failSave = false;
    h.restored = new Map();
    h.failDispatch = false;
    h.onDispatch = () => {};
    h.onHistory = () => {};
    h.gateway.mockClear();
    h.announce.mockClear();
    h.save.mockClear();
  });
  afterEach(() => registry.resetSubagentRegistryForTests({ persist: false }));
  const register = (trusted = true) => {
    const run = () =>
      registry.registerSubagentRun({
        runId: "initial",
        childSessionKey: child,
        requesterSessionKey: parent,
        requesterDisplayKey: "test",
        task: "Implement the authorized changes",
        model: "provider/primary",
        costSystemPrompt: "Synthetic worker scope",
        cleanup: "keep",
        runTimeoutSeconds: 60,
        expectsCompletionMessage: true,
      });
    if (trusted) {
      withCostTaskSpawnContext({ requesterSessionKey: parent, agentId: "main" }, run);
    } else {
      run();
    }
  };
  const end = (runId: string) =>
    h.handler?.({
      stream: "lifecycle",
      runId,
      seq: 1,
      ts: Date.now(),
      data: { phase: "end", endedAt: Date.now() },
    });
  const dispatches = () => h.gateway.mock.calls.filter(([request]) => request.method === "agent");

  it("persists and resumes the same session/model once, then announces remaining partial work", async () => {
    register();
    const deadline = h.snapshot.get("initial")!.costTask!.deadlineAt;
    end("initial");
    end("initial");
    await vi.waitFor(() => expect(dispatches()).toHaveLength(1));
    const next = registry.listSubagentRunsForRequester(parent)[0];
    expect(next.runId).toMatch(/^cost-continuation:/);
    expect(next.childSessionKey).toBe(child);
    expect(next.model).toBe("provider/primary");
    expect(next.costTask).toMatchObject({ deadlineAt: deadline, continuations: 1 });
    expect(h.snapshot.get(next.runId)?.costTask?.continuations).toBe(1);
    expect(dispatches()[0][0].params).toMatchObject({ sessionKey: child, deliver: false });
    expect(dispatches()[0][0].params?.extraSystemPrompt).toBe("Synthetic worker scope");
    expect(h.announce).not.toHaveBeenCalled();
    end(next.runId);
    await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(dispatches()).toHaveLength(1);
  });

  it.each(["ordinary", "off", "pending-remote", "stopped-parent", "changed-model"])(
    "does not auto-continue %s work",
    async (kind) => {
      if (kind === "off") {
        h.config.agents!.defaults!.modelRouting = "off";
      }
      register(kind !== "ordinary");
      if (kind === "pending-remote") {
        h.history = [
          {
            role: "toolResult",
            toolName: "remote_run",
            toolCallId: "one",
            content: [{ type: "text", text: '{"status":"running","task_id":"existing"}' }],
          },
        ];
      }
      if (kind === "stopped-parent") {
        h.sessions[parent].abortedLastRun = true;
      }
      if (kind === "changed-model") {
        h.sessions[child].modelOverride = "another";
      }
      end("initial");
      await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
      expect(dispatches()).toHaveLength(0);
      if (kind === "ordinary" || kind === "off") {
        expect(h.historyReads).toBe(0);
      }
    },
  );

  it("does not dispatch after a stop arrives while reading evidence", async () => {
    register();
    h.onHistory = () => {
      registry.markSubagentRunTerminated({ runId: "initial", reason: "killed" });
    };
    end("initial");
    await vi.waitFor(() => expect(h.historyReads).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispatches()).toHaveLength(0);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it.each(["parent-reset", "child-reset"])(
    "does not read or report into reassigned %s context",
    async (kind) => {
      register();
      h.sessions[kind === "parent-reset" ? parent : child].sessionId = "replacement-session";
      end("initial");
      await vi.waitFor(() =>
        expect(registry.listSubagentRunsForRequester(parent)[0].costTask?.cancelled).toBe(true),
      );
      expect(dispatches()).toHaveLength(0);
      expect(h.historyReads).toBe(0);
      expect(h.announce).not.toHaveBeenCalled();
    },
  );

  it("rechecks mode and session identity after inspecting evidence", async () => {
    register();
    h.onHistory = () => {
      h.sessions[parent].sessionId = "new-parent-session";
    };
    end("initial");
    await vi.waitFor(() =>
      expect(registry.listSubagentRunsForRequester(parent)[0].costTask?.cancelled).toBe(true),
    );
    expect(dispatches()).toHaveLength(0);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("does not reserve a continuation when cost is disabled while inspecting evidence", async () => {
    register();
    h.onHistory = () => {
      h.config.agents!.defaults!.modelRouting = "off";
    };
    end("initial");
    await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(dispatches()).toHaveLength(0);
  });

  it("does not abort a new child session after the original context was reset during dispatch", async () => {
    register();
    h.onDispatch = () => {
      h.sessions[child].sessionId = "new-child-session";
    };
    end("initial");
    await vi.waitFor(() =>
      expect(registry.listSubagentRunsForRequester(parent)[0].costTask?.cancelled).toBe(true),
    );
    expect(h.gateway.mock.calls.filter(([r]) => r.method === "chat.abort")).toHaveLength(0);
    expect(registry.listSubagentRunsForRequester(parent)[0].cleanupCompletedAt).toBeTypeOf(
      "number",
    );
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("never dispatches when durable reservation fails", async () => {
    register();
    h.failSave = true;
    end("initial");
    await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(dispatches()).toHaveLength(0);
    expect(registry.listSubagentRunsForRequester(parent)[0].runId).toBe("initial");
  });

  it("does not resurrect a cancelled reserved run after a late successful end", async () => {
    register();
    h.onDispatch = (runId) => {
      registry.markSubagentRunTerminated({ runId, reason: "killed" });
    };
    end("initial");
    await vi.waitFor(() =>
      expect(h.gateway.mock.calls.some(([r]) => r.method === "chat.abort")).toBe(true),
    );
    const next = registry.listSubagentRunsForRequester(parent)[0];
    expect(registry.isCostTaskContinuationAllowed(next.runId, child)).toBe(false);
    end(next.runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.announce).not.toHaveBeenCalled();
    expect(dispatches()).toHaveLength(1);
  });

  it("reports an unconfirmed dispatch as blocked and never retries it", async () => {
    register();
    h.failDispatch = true;
    end("initial");
    await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(dispatches()).toHaveLength(1);
    const announce = h.announce.mock.calls[0][0] as {
      roundOneReply?: string;
      outcome?: { status: string };
    };
    expect(announce.roundOneReply).toContain("dispatch unconfirmed");
    expect(announce.outcome?.status).toBe("error");
  });

  it("never replays a reservation whose dispatch was unconfirmed across restart", async () => {
    h.restored.set("reserved-before-restart", {
      runId: "reserved-before-restart",
      childSessionKey: child,
      requesterSessionKey: parent,
      requesterDisplayKey: "test",
      task: "synthetic",
      cleanup: "keep",
      createdAt: Date.now(),
      model: "provider/primary",
      expectsCompletionMessage: true,
      costTask: { deadlineAt: Date.now() + 60000, continuations: 1, dispatchUnconfirmed: true },
    });
    registry.initSubagentRegistry();
    await vi.waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(dispatches()).toHaveLength(0);
    expect(registry.isCostTaskContinuationAllowed("reserved-before-restart", child)).toBe(false);
    expect(h.snapshot.get("reserved-before-restart")?.costTask?.cancelled).toBe(true);
  });
});

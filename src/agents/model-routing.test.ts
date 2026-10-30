import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AgentsSchema } from "../config/zod-schema.agents.js";
import { classifyCostTask } from "./cost-task-classifier.js";
import { getCostTaskSpawnContext } from "./cost-task-protocol.js";
import {
  applyCostRoutingToolPolicy,
  isSelfContainedTextTask,
  resolveCostRoutingModels,
  resolveCostRoutingPlan,
  resolveCostRoutingExecutionPlan,
} from "./model-routing.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("./cost-task-classifier.js", () => ({ classifyCostTask: vi.fn() }));
beforeEach(() => {
  vi.mocked(classifyCostTask).mockReset().mockResolvedValue("secondary");
});

const config: OpenClawConfig = {
  agents: {
    defaults: {
      modelRouting: "cost",
      model: { primary: "ddww/sol" },
      models: { "ddww/sol": { alias: "planner" }, "ddww/terra": { alias: "worker" } },
      subagents: { model: { primary: "ddww/terra" } },
    },
  },
};
const base: RunEmbeddedPiAgentParams = {
  config,
  sessionKey: "agent:main:main",
  sessionId: "session",
  sessionFile: "/tmp/session.jsonl",
  workspaceDir: "/tmp/workspace",
  runId: "run",
  timeoutMs: 30000,
  trigger: "user",
  provider: "ddww",
  model: "sol",
  prompt: "请排查生产环境 OOM 并修复代码",
};
function makeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
  };
}

describe("cost routing compatibility", () => {
  it("accepts only the new opt-in policy, preserving strict model schema", () => {
    expect(AgentsSchema.safeParse(config.agents).success).toBe(true);
    expect(
      AgentsSchema.safeParse({ defaults: { modelRoutingClassifier: "ddww/gpt-6-luna" } }).success,
    ).toBe(true);
    expect(AgentsSchema.safeParse({ defaults: { modelRoutingClassifier: " " } }).success).toBe(
      false,
    );
    expect(
      AgentsSchema.safeParse({
        defaults: { modelRoutingClassifier: { primary: "ddww/gpt-6-luna" } },
      }).success,
    ).toBe(false);
    expect(AgentsSchema.safeParse({ defaults: { modelRouting: "automatic" } }).success).toBe(false);
    expect(
      AgentsSchema.safeParse({
        defaults: { model: { primary: "ddww/sol", secondary: "ddww/terra" } },
      }).success,
    ).toBe(false);
  });
  it("is off unless explicitly enabled", () => {
    const cfg = structuredClone(config);
    delete cfg.agents!.defaults!.modelRouting;
    expect(resolveCostRoutingModels(cfg, "main")).toBeUndefined();
    cfg.agents!.defaults!.modelRouting = "off";
    expect(resolveCostRoutingModels(cfg, "main")).toBeUndefined();
  });
  it.each(["ddww/sol", "planner", { primary: "ddww/sol", fallbacks: ["ddww/terra"] }])(
    "bypasses equal models including aliases: %j",
    (model) => {
      const cfg = structuredClone(config);
      cfg.agents!.defaults!.subagents!.model = model;
      expect(resolveCostRoutingModels(cfg, "main")).toBeUndefined();
      expect(resolveCostRoutingPlan({ ...base, config: cfg })).toBeUndefined();
    },
  );
  it("resolves the worker alias and respects the model allowlist", () => {
    const cfg = structuredClone(config);
    cfg.agents!.defaults!.subagents!.model = "worker";
    expect(resolveCostRoutingModels(cfg, "main")?.worker).toEqual({
      provider: "ddww",
      model: "terra",
    });
    delete cfg.agents!.defaults!.models!["ddww/terra"];
    expect(resolveCostRoutingModels(cfg, "main")).toBeUndefined();
  });
  it("honors per-agent disable and model overrides", () => {
    const cfg = structuredClone(config);
    cfg.agents!.list = [{ id: "main", modelRouting: "off" }];
    expect(resolveCostRoutingPlan({ ...base, config: cfg })).toBeUndefined();
    cfg.agents!.list = [{ id: "main", model: "ddww/terra" }];
    expect(resolveCostRoutingModels(cfg, "main")).toBeUndefined();
  });
  it.each([
    { trigger: "heartbeat" },
    { trigger: "memory" },
    { trigger: "cron" },
    { trigger: undefined },
    { model: "explicit-override" },
    { provider: "another" },
    { spawnedBy: "agent:main:main" },
    { sessionKey: "agent:main:subagent:child" },
    { sessionKey: "agent:main:cron:job:run:123" },
    { authProfileIdSource: "user" as const },
    { disableTools: true },
    { clientTools: [{ type: "function" as const, function: { name: "hosted" } }] },
    { images: [{ type: "image" as const, data: "x", mimeType: "image/png" }] },
  ])("keeps explicit and background runs unchanged: %j", (override) => {
    expect(resolveCostRoutingPlan({ ...base, ...override })).toBeUndefined();
  });
  it("sends execution and acceptance follow-ups to the primary", () => {
    expect(resolveCostRoutingPlan(base)?.role).toBe("orchestrator");
    expect(resolveCostRoutingPlan({ ...base, prompt: "继续" })?.role).toBe("orchestrator");
    expect(
      resolveCostRoutingPlan({
        ...base,
        prompt: "你好",
        inputProvenance: { kind: "inter_session" },
      })?.role,
    ).toBe("orchestrator");
  });
  it("classifies clean channel text without removing metadata from the model prompt", () => {
    const params = {
      ...base,
      prompt:
        'Sender (untrusted metadata): {"id":"sender"}\n[Tue 2026-10-27] 请翻译成中文：Good morning.',
      modelRoutingPrompt: "请翻译成中文：Good morning.",
    };
    expect(resolveCostRoutingPlan(params)?.role).toBe("direct");
    expect(params.prompt).toContain("untrusted metadata");
    expect(resolveCostRoutingPlan({ ...params, modelRoutingPrompt: "" })?.role).toBe(
      "orchestrator",
    );
  });
  it("sends an inline translation to the worker without a classifier model call", () => {
    expect(resolveCostRoutingPlan({ ...base, prompt: "请翻译成中文：Good morning." })?.role).toBe(
      "direct",
    );
  });
});

describe("conservative simple-task classifier", () => {
  it.each([
    "你好",
    "hello!",
    "谢谢！",
    "请计算：123 * (4 + 5)",
    "翻译成英文：早上好。",
    "请润色以下文字：今天工作已完成。",
    "summarize the following text: A long test sentence.",
  ])("routes self-contained text: %s", (prompt) => {
    expect(isSelfContainedTextTask(prompt)).toBe(true);
  });
  it.each([
    "继续",
    "这个什么意思",
    "总结：之前的讨论",
    "修复登录错误",
    "排查 OOM",
    "翻译附件内容",
    "请总结：https://example.com",
    "你好，帮我删除文件",
    "计算利润并查数据库",
    "解释这个错误",
    "x".repeat(3001),
  ])("keeps uncertain tasks primary: %s", (prompt) => {
    expect(isSelfContainedTextTask(prompt)).toBe(false);
  });
});

describe("classification before primary execution", () => {
  it("keeps advanced work in the current primary session", async () => {
    vi.mocked(classifyCostTask).mockResolvedValue("primary");
    expect((await resolveCostRoutingExecutionPlan(base))?.role).toBe("primary");
    expect(classifyCostTask).toHaveBeenCalledTimes(1);
    const tools = [makeTool("remote_run"), makeTool("write"), makeTool("sessions_spawn")];
    const result = applyCostRoutingToolPolicy(tools, "primary", {
      config,
      agentId: "main",
      workerModel: "ddww/terra",
    });
    expect(result.tools[0]).toBe(tools[0]);
    expect(result.tools[1]).toBe(tools[1]);
    expect(result.systemPrompt).toContain("directly in this session");
  });
  it("classifies ordinary work once before tool construction", async () => {
    expect((await resolveCostRoutingExecutionPlan(base))?.role).toBe("orchestrator");
    expect(classifyCostTask).toHaveBeenCalledTimes(1);
  });
  it("does not classify bypassed or direct-text requests", async () => {
    expect(await resolveCostRoutingExecutionPlan({ ...base, config: {} })).toBeUndefined();
    expect(
      (await resolveCostRoutingExecutionPlan({ ...base, prompt: "翻译成中文：Good morning." }))
        ?.role,
    ).toBe("direct");
    expect(classifyCostTask).not.toHaveBeenCalled();
  });
  it("reuses the selected role for internal completion without another classification", async () => {
    const params = { ...base, sessionId: "internal-primary-owner" };
    vi.mocked(classifyCostTask).mockResolvedValue("primary");
    await resolveCostRoutingExecutionPlan(params);
    expect(
      (
        await resolveCostRoutingExecutionPlan({
          ...params,
          inputProvenance: { kind: "inter_session" },
          prompt: "Worker completed.",
        })
      )?.role,
    ).toBe("primary");
    expect(classifyCostTask).toHaveBeenCalledTimes(1);
    expect(
      (
        await resolveCostRoutingExecutionPlan({
          ...params,
          sessionId: "reset-session",
          inputProvenance: { kind: "inter_session" },
        })
      )?.role,
    ).toBe("primary");
    expect(classifyCostTask).toHaveBeenCalledTimes(1);
  });
  it("does not permanently pin new external tasks to the previous role", async () => {
    const params = { ...base, sessionId: "new-external-task" };
    vi.mocked(classifyCostTask).mockResolvedValueOnce("primary").mockResolvedValueOnce("secondary");
    expect((await resolveCostRoutingExecutionPlan(params))?.role).toBe("primary");
    expect(
      (
        await resolveCostRoutingExecutionPlan({
          ...params,
          prompt: "Run the existing export script.",
        })
      )?.role,
    ).toBe("orchestrator");
    expect(classifyCostTask).toHaveBeenCalledTimes(2);
  });
  it("preserves dispatch idempotency across internal result delivery, but resets on a new user request", async () => {
    const params = { ...base, sessionId: "dispatch-scope-owner" };
    const first = await resolveCostRoutingExecutionPlan(params);
    const completion = await resolveCostRoutingExecutionPlan({
      ...params,
      inputProvenance: { kind: "inter_session" },
      prompt: "Completion",
    });
    expect(completion?.executionState).toBe(first?.executionState);
    expect((await resolveCostRoutingExecutionPlan(params))?.executionState).not.toBe(
      first?.executionState,
    );
  });
  it("keeps an older child completion attached to its original task after a newer user request", async () => {
    const params = { ...base, sessionId: "overlapping-user-turns" };
    vi.mocked(classifyCostTask).mockResolvedValueOnce("primary").mockResolvedValueOnce("secondary");
    const first = await resolveCostRoutingExecutionPlan(params);
    const spawn = makeTool("sessions_spawn");
    vi.mocked(spawn.execute).mockImplementation(async () => {
      getCostTaskSpawnContext()?.onChildSession?.("agent:main:subagent:older-task");
      return { content: [], details: {} };
    });
    const [tool] = applyCostRoutingToolPolicy([spawn], "primary", {
      config,
      agentId: "main",
      workerModel: "ddww/terra",
      requesterSessionKey: params.sessionKey,
      executionState: first?.executionState,
    }).tools;
    await tool.execute("spawn", { task: "Independent routine check" });
    await resolveCostRoutingExecutionPlan({ ...params, prompt: "New ordinary task" });
    const completion = await resolveCostRoutingExecutionPlan({
      ...params,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:older-task",
      },
    });
    expect(completion?.role).toBe("primary");
    expect(completion?.executionState).toBe(first?.executionState);
    expect(classifyCostTask).toHaveBeenCalledTimes(2);
  });
  it("falls back on classifier failure but honors cancellation before executing", async () => {
    vi.mocked(classifyCostTask).mockRejectedValue(new Error("Unavailable"));
    expect((await resolveCostRoutingExecutionPlan(base))?.role).toBe("orchestrator");
    const controller = new AbortController();
    vi.mocked(classifyCostTask).mockImplementation(async () => {
      controller.abort();
      return "primary";
    });
    await expect(
      resolveCostRoutingExecutionPlan({ ...base, abortSignal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("cost routing tool policy", () => {
  const routingContext = {
    config,
    agentId: "main",
    agentDir: "/tmp/test-agent",
    primaryModel: "ddww/sol",
    workerModel: "ddww/terra",
  };
  it("preserves exact tool instances when routing is bypassed", () => {
    const tools = [makeTool("exec"), makeTool("sessions_spawn")];
    expect(applyCostRoutingToolPolicy(tools, undefined).tools).toBe(tools);
  });
  it("disables all tools for direct text transforms", () => {
    expect(applyCostRoutingToolPolicy([makeTool("exec")], "direct").tools).toEqual([]);
  });
  it("never grants a denied spawn tool and retains restricted agents' tool flow", () => {
    const tools = [makeTool("exec")];
    expect(applyCostRoutingToolPolicy(tools, "orchestrator")).toEqual({ tools });
  });
  it("restricts primary to orchestration and evidence reading", () => {
    const result = applyCostRoutingToolPolicy(
      [
        "exec",
        "write",
        "read",
        "remote_task",
        "sessions_history",
        "sessions_spawn",
        "sessions_yield",
        "subagents",
      ].map(makeTool),
      "orchestrator",
    );
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "sessions_yield",
      "subagents",
    ]);
    expect(result.systemPrompt).toContain("final reviewer");
    expect(result.systemPrompt).toContain("user constraints and authorizations");
  });
  it("retains only authorized read-only remote results for planners", () => {
    const resultTool = makeTool("remote_task_result");
    const tools = [
      resultTool,
      ...["remote_run", "remote_task", "remote_cancel", "sessions_spawn"].map(makeTool),
    ];
    const result = applyCostRoutingToolPolicy(tools, "orchestrator", routingContext);
    expect(result.tools.map((tool) => tool.name)).toEqual(["remote_task_result", "sessions_spawn"]);
    expect(result.tools[0]).toBe(resultTool);
    expect(result.systemPrompt).toContain("do not spawn another worker to recover that result");
    expect(
      applyCostRoutingToolPolicy(
        [makeTool("sessions_spawn")],
        "orchestrator",
        routingContext,
      ).tools.map((tool) => tool.name),
    ).toEqual(["sessions_spawn"]);
  });
  it("keeps the single-model compatibility tool list unchanged", () => {
    const tools = ["remote_run", "remote_task", "remote_task_result", "remote_cancel"].map(
      makeTool,
    );
    expect(applyCostRoutingToolPolicy(tools, undefined).tools).toBe(tools);
    expect(
      applyCostRoutingToolPolicy(tools, "orchestrator", {
        ...routingContext,
        config: {},
      }).tools,
    ).toBe(tools);
  });
  it("pins same-agent execution to the worker, adds a brief, and preserves permission arguments", async () => {
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", {
      agentId: "main",
      workerModel: "ddww/terra",
    }).tools;
    await tool.execute("call", {
      task: "Run the approved checks",
      agentId: "main",
      model: "ddww/sol",
      sandbox: "require",
    });
    expect(original.execute).toHaveBeenCalledWith(
      "call",
      expect.objectContaining({
        model: "ddww/terra",
        sandbox: "require",
        task: expect.stringContaining("Run the approved checks"),
      }),
      undefined,
      undefined,
    );
  });
  it("retains explicit cross-agent model policy", async () => {
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", {
      agentId: "main",
      workerModel: "ddww/terra",
    }).tools;
    await tool.execute("call", { task: "Check", agentId: "specialist", model: "special/model" });
    expect(original.execute).toHaveBeenCalledWith(
      "call",
      expect.objectContaining({ agentId: "specialist", model: "special/model" }),
      undefined,
      undefined,
    );
  });
  it("does not start an unrelated ACP runtime in cost mode", () => {
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", {
      agentId: "main",
      workerModel: "ddww/terra",
    }).tools;
    expect(() => tool.execute("call", { runtime: "acp", task: "Check" })).toThrow(
      "runtime=subagent",
    );
    expect(original.execute).not.toHaveBeenCalled();
  });

  it.each(["primary", "orchestrator"] as const)(
    "uses only the secondary model for routine delegation from %s",
    async (role) => {
      const original = makeTool("sessions_spawn");
      const [tool] = applyCostRoutingToolPolicy([original], role, routingContext).tools;
      await tool.execute("call", { task: "Approved bounded task", sandbox: "require" });
      expect(classifyCostTask).not.toHaveBeenCalled();
      expect(original.execute).toHaveBeenCalledWith(
        "call",
        expect.objectContaining({
          model: "ddww/terra",
          sandbox: "require",
          task: expect.stringContaining("Approved bounded task"),
        }),
        undefined,
        undefined,
      );
    },
  );

  it.each([undefined, "off"] as const)(
    "leaves tools, model arguments and requests untouched when policy is %s",
    async (policy) => {
      const cfg = structuredClone(config);
      cfg.agents!.defaults!.modelRouting = policy;
      const original = makeTool("sessions_spawn");
      const tools = [makeTool("exec"), original];
      const result = applyCostRoutingToolPolicy(tools, "orchestrator", {
        ...routingContext,
        config: cfg,
      });
      expect(result.tools).toBe(tools);
      expect(result.systemPrompt).toBeUndefined();
      const args = { task: "Check", model: "custom/model" };
      await result.tools[1].execute("call", args);
      expect(original.execute).toHaveBeenCalledWith("call", args);
      expect(classifyCostTask).not.toHaveBeenCalled();
    },
  );

  it("does not classify direct text or cross-agent work", async () => {
    const original = makeTool("sessions_spawn");
    expect(applyCostRoutingToolPolicy([original], "direct", routingContext).tools).toEqual([]);
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    await tool.execute("call", { task: "Check", agentId: "specialist", model: "special/model" });
    expect(original.execute).toHaveBeenCalledWith(
      "call",
      expect.objectContaining({ model: "special/model" }),
      undefined,
      undefined,
    );
    expect(classifyCostTask).not.toHaveBeenCalled();
  });

  it("reuses identical spawn results across wrappers in the same execution, but not a new request", async () => {
    const original = makeTool("sessions_spawn");
    const context = { ...routingContext, executionState: { spawns: new Map() } };
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", context).tools;
    await tool.execute("one", { task: "Same bounded task" });
    await tool.execute("two", { task: "Same bounded task" });
    expect(original.execute).toHaveBeenCalledTimes(1);
    const [nextTurn] = applyCostRoutingToolPolicy([original], "orchestrator", context).tools;
    await nextTurn.execute("three", { task: "Same bounded task" });
    expect(original.execute).toHaveBeenCalledTimes(1);
    const [newRequest] = applyCostRoutingToolPolicy(
      [original],
      "orchestrator",
      routingContext,
    ).tools;
    await newRequest.execute("four", { task: "Same bounded task" });
    expect(original.execute).toHaveBeenCalledTimes(2);
    expect(classifyCostTask).not.toHaveBeenCalled();
  });

  it("compares the full spawn arguments, including nested options and sandbox requirements", async () => {
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    await tool.execute("one", { task: "Check", sandbox: "require", options: { a: 1, b: 2 } });
    await tool.execute("two", { options: { b: 2, a: 1 }, sandbox: "require", task: "Check" });
    expect(original.execute).toHaveBeenCalledTimes(1);
    await tool.execute("three", { task: "Check", sandbox: "inherit", options: { a: 1, b: 2 } });
    await tool.execute("four", { task: "Check", sandbox: "require", options: { a: 1, b: 3 } });
    expect(original.execute).toHaveBeenCalledTimes(3);
  });

  it("shares concurrent dispatches and does not retry an unconfirmed failure", async () => {
    const original = makeTool("sessions_spawn");
    vi.mocked(original.execute).mockRejectedValue(new Error("Dispatch not confirmed"));
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    const result = await Promise.allSettled([
      tool.execute("one", { task: "Check" }),
      tool.execute("two", { task: "Check" }),
    ]);
    expect(result.every((value) => value.status === "rejected")).toBe(true);
    expect(original.execute).toHaveBeenCalledTimes(1);
    await expect(tool.execute("three", { task: "Check" })).rejects.toThrow("not confirmed");
    expect(original.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds distinct dispatches without evicting earlier idempotency records", async () => {
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    for (let i = 0; i < 32; i++) {
      await tool.execute(String(i), { task: `Check ${i}` });
    }
    expect(() => tool.execute("overflow", { task: "Check 32" })).toThrow("spawn budget");
    await tool.execute("duplicate", { task: "Check 0" });
    expect(original.execute).toHaveBeenCalledTimes(32);
  });

  it("preserves the complete long execution task and attributes only trusted cost spawns", async () => {
    const original = makeTool("sessions_spawn");
    let owner: string | undefined;
    let received = "";
    vi.mocked(original.execute).mockImplementation(async (_id, args) => {
      owner = getCostTaskSpawnContext()?.requesterSessionKey;
      received = String((args as { task: string }).task);
      return { content: [], details: {} };
    });
    const context = { ...routingContext, requesterSessionKey: "agent:main:main" };
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", context).tools;
    const task = "Implement the actual authorized changes. " + "x".repeat(5000);
    await tool.execute("cost", { task });
    expect(owner).toBe("agent:main:main");
    expect(received.startsWith(task)).toBe(true);
    expect(received).not.toContain("<cost_task_result>");
    expect(getCostTaskSpawnContext()).toBeUndefined();
    await tool.execute("cross-agent", { task: "Inspect", agentId: "specialist" });
    expect(owner).toBeUndefined();
    expect(received).not.toContain("<cost_task_result>");
  });

  it("defaults unexpected classifier errors to the worker", async () => {
    vi.mocked(classifyCostTask).mockRejectedValue(new Error("classification failed"));
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    await tool.execute("call", { task: "Check" });
    expect(original.execute).toHaveBeenCalledWith(
      "call",
      expect.objectContaining({ model: "ddww/terra" }),
      undefined,
      undefined,
    );
  });

  it("never spawns after cancellation before a reserved dispatch starts", async () => {
    const controller = new AbortController();
    const original = makeTool("sessions_spawn");
    const [tool] = applyCostRoutingToolPolicy([original], "orchestrator", routingContext).tools;
    const pending = tool.execute("call", { task: "Check" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(original.execute).not.toHaveBeenCalled();
  });
});

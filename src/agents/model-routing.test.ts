import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AgentsSchema } from "../config/zod-schema.agents.js";
import {
  applyCostRoutingToolPolicy,
  isSelfContainedTextTask,
  resolveCostRoutingModels,
  resolveCostRoutingPlan,
} from "./model-routing.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { AnyAgentTool } from "./tools/common.js";

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

describe("cost routing tool policy", () => {
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
});

import fs from "node:fs/promises";
import http from "node:http";
import { Type } from "@sinclair/typebox";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as guardedFetch from "../infra/net/fetch-guard.js";
import * as logging from "../logging/subsystem.js";
import type { AnyAgentTool } from "./tools/common.js";

// Explicit opt-in only. Never embed keys, user tasks or a host configuration path.
it.skipIf(!process.env.OPENCLAW_COST_CLASSIFIER_SMOKE_CONFIG)(
  "classifies synthetic tasks through the real transport without executing them",
  async () => {
    const path = process.env.OPENCLAW_COST_CLASSIFIER_SMOKE_CONFIG!;
    const loaded = JSON.parse(await fs.readFile(path, "utf8")) as OpenClawConfig;
    const classifier =
      process.env.OPENCLAW_COST_CLASSIFIER_SMOKE_MODEL ??
      loaded.agents?.defaults?.modelRoutingClassifier;
    if (!classifier) {
      throw new Error(
        "Configure an independent classifier provider before running the live smoke test",
      );
    }
    const config: OpenClawConfig = {
      models: loaded.models,
      agents: {
        defaults: {
          model: loaded.agents?.defaults?.model,
          models: loaded.agents?.defaults?.models,
          modelRouting: "cost",
          modelRoutingClassifier: classifier,
        },
      },
    };
    const decisions: Array<Record<string, unknown> | undefined> = [];
    const originalLogger = logging.createSubsystemLogger;
    vi.spyOn(logging, "createSubsystemLogger").mockImplementation((name) => {
      const logger = originalLogger(name);
      return name === "agents/cost-routing"
        ? {
            ...logger,
            info: (_message, metadata) => {
              decisions.push(metadata);
            },
          }
        : logger;
    });
    const requests = vi.spyOn(guardedFetch, "fetchWithSsrFGuard");
    const { classifyCostTask } = await import("./cost-task-classifier.js");
    try {
      for (const policy of [undefined, "off"] as const) {
        const disabled: OpenClawConfig = {
          ...config,
          agents: { defaults: { ...config.agents!.defaults, modelRouting: policy } },
        };
        await classifyCostTask({ config: disabled, agentId: "main", task: "No classifier call." });
      }
      expect(requests).not.toHaveBeenCalled();
      for (const [id, task, expected] of [
        ["vague", "帮我弄一下这个，没有其他上下文。", "secondary"],
        [
          "existing_script",
          "只运行现成导出脚本，返回器件数量，不修改代码或设计版图。",
          "secondary",
        ],
        [
          "new_code",
          "开发新的取消和并发状态恢复机制，接口细节先查看源码并设计修复策略。",
          "primary",
        ],
        [
          "derive_geometry",
          "根据器件与adapter实际几何推导镜像方向和对齐策略，然后修改布局并验证。",
          "primary",
        ],
        [
          "long_engineering_task",
          "要求实际设计并修改版图，不是仅备份和检查。" +
            " implementation constraint".repeat(210) +
            " 验收要求保存修改并独立回读验证。",
          "primary",
        ],
        [
          "middle_engineering_goal",
          "以下是已有检查记录，待办要求在中间。\n" +
            "completed check: value=0.5\n".repeat(150) +
            "真正待办：自行推导隔离和接触方向，设计版图分区策略，实际移动器件并实现 guard ring 和 tap，然后保存并独立验证。\n" +
            "completed check: value=0.5\n".repeat(150) +
            "以上背景记录结束。",
          "primary",
        ],
      ] as const) {
        const start = Date.now();
        const route = await classifyCostTask({ config, agentId: "main", task });
        const decision = decisions.at(-1);
        console.log(
          JSON.stringify({
            id,
            route,
            expected,
            source: decision?.source,
            elapsedMs: Date.now() - start,
          }),
        );
        expect(decision?.source).toBe("classifier");
        expect(route).toBe(expected);
        const body = requests.mock.calls.at(-1)?.[0].init?.body;
        if (typeof body !== "string") {
          throw new Error("Expected a serialized classifier request");
        }
        const payload = JSON.parse(body);
        expect(payload.reasoning_effort).toBe("none");
        expect(payload.messages).toHaveLength(2);
        expect(JSON.parse(payload.messages[1].content)).toEqual({ task });
      }
      expect(requests).toHaveBeenCalledTimes(6);
    } finally {
      vi.restoreAllMocks();
    }
  },
  30_000,
);

// Real sockets and wall-clock deadlines, not fake timers or mocked HTTP responses.
it("routes real local HTTP responses, deadlines and cancellations without affecting non-cost", async () => {
  const { applyCostRoutingToolPolicy, resolveCostRoutingExecutionPlan } =
    await import("./model-routing.js");
  let hold = false;
  let requests = 0;
  let effort: unknown;
  let notifyArrival: () => void = () => {};
  const server = http.createServer(async (request, response) => {
    requests += 1;
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    effort = JSON.parse(body).reasoning_effort;
    notifyArrival();
    if (!hold) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"route":"primary"}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 12 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local test server unavailable");
  }
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        modelRouting: "cost",
        modelRoutingClassifier: "local/route-model",
        model: "local/primary",
        subagents: { model: "local/secondary" },
        models: { "local/primary": {}, "local/secondary": {} },
      },
    },
    models: {
      providers: {
        local: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-local-only-key",
          models: [],
        },
      },
    },
  };
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "synthetic" }],
    details: {},
  }));
  const original: AnyAgentTool = {
    name: "sessions_spawn",
    label: "test",
    description: "Records synthetic execution only",
    parameters: Type.Object({}),
    execute,
  };
  const tools = (cfg = config) =>
    applyCostRoutingToolPolicy([original], "orchestrator", {
      config: cfg,
      agentId: "main",
      primaryModel: "local/primary",
      workerModel: "local/secondary",
    }).tools[0];
  const dispatch = async (id: string, task: string, signal?: AbortSignal) => {
    const plan = await resolveCostRoutingExecutionPlan({
      config,
      sessionId: `synthetic-${id}`,
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/synthetic-not-executed.jsonl",
      workspaceDir: "/tmp",
      runId: id,
      timeoutMs: 10000,
      trigger: "user",
      provider: "local",
      model: "primary",
      prompt: task,
      abortSignal: signal,
    });
    if (plan?.role === "orchestrator") {
      await tools().execute(id, { task }, signal);
    }
    return plan?.role;
  };
  try {
    expect(await dispatch("normal", "Derive a synthetic engineering strategy.")).toBe("primary");
    expect(requests).toBe(1);
    expect(effort).toBe("none");
    expect(execute).not.toHaveBeenCalled();

    hold = true;
    const start = Date.now();
    expect(await dispatch("deadline", "Synthetic delayed task.")).toBe("orchestrator");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(6500);
    expect(requests).toBe(2);
    expect(execute).toHaveBeenLastCalledWith(
      "deadline",
      expect.objectContaining({ model: "local/secondary" }),
      undefined,
      undefined,
    );

    const beforeCancel = execute.mock.calls.length;
    const controller = new AbortController();
    const arrived = new Promise<void>((resolve) => {
      notifyArrival = resolve;
    });
    const cancelled = dispatch("cancel", "Synthetic cancelled task.", controller.signal);
    const observed = cancelled.then(
      () => "resolved",
      () => "rejected",
    );
    await arrived;
    controller.abort();
    expect(await observed).toBe("rejected");
    expect(execute).toHaveBeenCalledTimes(beforeCancel);
    expect(requests).toBe(3);

    for (const policy of [undefined, "off"] as const) {
      const disabled: OpenClawConfig = {
        ...config,
        agents: { defaults: { ...config.agents!.defaults, modelRouting: policy } },
      };
      const input = { task: "Synthetic unchanged task.", model: "original/model" };
      await tools(disabled).execute("bypass", input);
      expect(execute).toHaveBeenLastCalledWith("bypass", input);
      expect(requests).toBe(3);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

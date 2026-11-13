import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CostRoutingMemory } from "./cost-routing-memory.js";
import { classifyCostTask } from "./cost-task-classifier.js";
import { rememberCostRoutingTurn, resolveCostRoutingExecutionPlan } from "./model-routing.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

vi.mock("./cost-task-classifier.js", () => ({ classifyCostTask: vi.fn() }));
let directory: string;
let params: RunEmbeddedPiAgentParams;
let lines: object[];
const config: OpenClawConfig = {
  agents: {
    defaults: {
      modelRouting: "cost",
      model: { primary: "test/primary" },
      models: { "test/primary": {}, "test/worker": {} },
      subagents: { model: "test/worker" },
    },
  },
};
const result = { meta: { durationMs: 1 } };
async function save() {
  await fs.writeFile(
    params.sessionFile,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}
function message(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
  };
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-routing-integration-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  params = {
    config: structuredClone(config),
    agentId: "test",
    sessionKey: "agent:test:main",
    sessionId: path.basename(directory),
    sessionFile: path.join(directory, "session.jsonl"),
    workspaceDir: directory,
    runId: "first",
    timeoutMs: 10000,
    trigger: "user",
    provider: "test",
    model: "primary",
    prompt: "Design an algorithm",
  };
  lines = [
    { type: "session", version: 3, id: params.sessionId, timestamp: new Date().toISOString() },
    message("original", null, "user", params.prompt),
    message("design", "original", "assistant", "Proposed design"),
  ];
  await save();
  vi.mocked(classifyCostTask).mockReset().mockResolvedValue("primary");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("task context at the cost execution boundary", () => {
  it("remembers direct secondary execution and classifies short follow-ups with its goal", async () => {
    vi.mocked(classifyCostTask).mockImplementation(async (p) => {
      p.onDecision?.({ route: "secondary", source: "classifier" });
      return "secondary";
    });
    const first = await resolveCostRoutingExecutionPlan(params);
    expect(first?.role).toBe("secondary");
    await rememberCostRoutingTurn(params, first, result);
    vi.mocked(classifyCostTask).mockImplementation(async (p) => {
      expect(p.previousTask).toMatchObject({ goal: params.prompt, route: "secondary" });
      p.onDecision?.({ route: "primary", relation: "continue", source: "classifier" });
      return "primary";
    });
    expect(
      (await resolveCostRoutingExecutionPlan({ ...params, prompt: "继续", runId: "next" }))?.role,
    ).toBe("primary");
  });

  it("carries the original goal through confirmed user turns and persists the native anchor", async () => {
    const first = await resolveCostRoutingExecutionPlan(params);
    await rememberCostRoutingTurn(params, first, result);
    vi.mocked(classifyCostTask).mockImplementation(async (p) => {
      expect(p.previousTask).toMatchObject({ goal: "Design an algorithm", route: "primary" });
      p.onDecision?.({ route: "primary", relation: "continue" });
      return "primary";
    });
    const nextParams = { ...params, runId: "second", prompt: "Proceed with the design" };
    const next = await resolveCostRoutingExecutionPlan(nextParams);
    expect(next?.role).toBe("primary");
    expect(next?.goalEntryId).toBe("original");
    expect(next?.executionState).not.toBe(first?.executionState);
    lines.push(
      message("confirmation", "design", "user", nextParams.prompt),
      message("delivery", "confirmation", "assistant", "result"),
    );
    await save();
    await rememberCostRoutingTurn(nextParams, next, result);
    await resolveCostRoutingExecutionPlan({
      ...nextParams,
      runId: "third",
      prompt: "Validate the result",
    });
    expect(vi.mocked(classifyCostTask).mock.calls.at(-1)?.[0].previousTask?.lastRequest).toBe(
      nextParams.prompt,
    );
  });
  it("starts a new goal when the classifier identifies independent work", async () => {
    const first = await resolveCostRoutingExecutionPlan(params);
    await rememberCostRoutingTurn(params, first, result);
    vi.mocked(classifyCostTask).mockImplementation(async (p) => {
      p.onDecision?.({ route: "secondary", relation: "new", source: "classifier" });
      return "secondary";
    });
    const next = await resolveCostRoutingExecutionPlan({
      ...params,
      prompt: "Extract supplied data",
    });
    expect(next?.role).toBe("secondary");
    expect(next?.goalEntryId).toBeUndefined();
  });
  it.each(["off", "same-model", "explicit-override"])(
    "does not use or record continuation state in %s mode",
    async (kind) => {
      const first = await resolveCostRoutingExecutionPlan(params);
      await rememberCostRoutingTurn(params, first, result);
      const spy = vi.spyOn(CostRoutingMemory.prototype, "recall");
      const write = vi.spyOn(CostRoutingMemory.prototype, "remember");
      const changed = { ...params, config: structuredClone(config) };
      if (kind === "off") {
        changed.config.agents!.defaults!.modelRouting = "off";
      }
      if (kind === "same-model") {
        changed.config.agents!.defaults!.subagents!.model = "test/primary";
      }
      if (kind === "explicit-override") {
        changed.model = "another";
      }
      expect(await resolveCostRoutingExecutionPlan(changed)).toBeUndefined();
      await rememberCostRoutingTurn(changed, first, result);
      expect(spy).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      spy.mockRestore();
      write.mockRestore();
    },
  );
  it("does not remember cancelled runs or overwrite state from an internal announcement", async () => {
    const first = await resolveCostRoutingExecutionPlan(params);
    const spy = vi.spyOn(CostRoutingMemory.prototype, "remember");
    await rememberCostRoutingTurn(params, first, { meta: { durationMs: 1, aborted: true } });
    await rememberCostRoutingTurn(
      { ...params, inputProvenance: { kind: "inter_session" } },
      first,
      result,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  costTaskStatusLabel,
  getCostTaskSpawnContext,
  guardCostContinuationTools,
  parseCostTaskResult,
  withCostTaskSpawnContext,
} from "./cost-task-protocol.js";
import type { AnyAgentTool } from "./tools/common.js";

const partial = {
  status: "partial",
  remaining: ["Implement layout changes"],
  blocker: null,
  pendingRemoteTasks: [],
  safeToResume: true,
};
const report = (value: unknown) =>
  `Only the backup is complete.\n<cost_task_result>${JSON.stringify(value)}</cost_task_result>`;
describe("cost task business receipt", () => {
  it("separates actual business status from a successfully ended run", () => {
    const parsed = parseCostTaskResult(report(partial));
    expect(parsed.receipt?.status).toBe("partial");
    expect(parsed.text).toBe("Only the backup is complete.");
    expect(costTaskStatusLabel(parsed.receipt)).toContain("not completed");
  });
  it.each([
    { ...partial, status: "completed" },
    { ...partial, status: "partial", remaining: [] },
    { ...partial, status: "blocked", blocker: null },
    { ...partial, safeToResume: "true" },
    { ...partial, extra: "instructions" },
  ])("does not authorize continuation from an inconsistent receipt", (receipt) => {
    expect(parseCostTaskResult(report(receipt)).receipt).toBeUndefined();
  });
  it("rejects missing, repeated or nonterminal protocol tags", () => {
    expect(parseCostTaskResult("未完成但没有实际阻塞").receipt).toBeUndefined();
    expect(parseCostTaskResult(report(partial) + " trailing text").receipt).toBeUndefined();
    expect(parseCostTaskResult(report(partial) + report(partial)).receipt).toBeUndefined();
    expect(costTaskStatusLabel()).toContain("unverified");
  });
  it("accepts a verified complete or concrete blocked contract", () => {
    expect(
      parseCostTaskResult(
        report({ ...partial, status: "completed", remaining: [], safeToResume: false }),
      ).receipt?.status,
    ).toBe("completed");
    expect(
      parseCostTaskResult(
        report({
          ...partial,
          status: "blocked",
          blocker: "Required license unavailable",
          safeToResume: false,
        }),
      ).receipt?.status,
    ).toBe("blocked");
  });
});

describe("cost-only trusted spawn context and cancellation", () => {
  it("keeps internal spawn attribution out of unrelated async work", async () => {
    expect(getCostTaskSpawnContext()).toBeUndefined();
    await withCostTaskSpawnContext(
      { requesterSessionKey: "agent:test:main", agentId: "test" },
      async () => {
        await Promise.resolve();
        expect(getCostTaskSpawnContext()?.agentId).toBe("test");
      },
    );
    expect(getCostTaskSpawnContext()).toBeUndefined();
  });
  it("preserves exact non-continuation tools and rejects late tools after a stop", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tools: AnyAgentTool[] = [
      {
        name: "write",
        label: "write",
        description: "synthetic",
        parameters: Type.Object({}),
        execute,
      },
    ];
    expect(guardCostContinuationTools(tools)).toBe(tools);
    let allowed = true;
    const [guarded] = guardCostContinuationTools(tools, () => allowed);
    await guarded.execute("one", {});
    allowed = false;
    expect(() => guarded.execute("two", {})).toThrow("cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

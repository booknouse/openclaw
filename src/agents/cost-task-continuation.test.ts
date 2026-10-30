import { describe, expect, it, vi } from "vitest";
import { continueCostTaskOnce, hasUnsettledCostTools } from "./cost-task-continuation.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function entry(): SubagentRunRecord {
  return {
    runId: "original-run",
    childSessionKey: "agent:test:subagent:child",
    requesterSessionKey: "agent:test:main",
    requesterDisplayKey: "test",
    task: "Implement and verify the requested changes",
    cleanup: "keep",
    createdAt: 0,
    startedAt: 0,
    endedAt: 100,
    model: "provider/primary",
    outcome: { status: "ok" },
    costTask: {
      deadlineAt: 60_000,
      continuations: 0,
      systemPrompt: "Synthetic worker scope",
      sessionId: "child",
      requesterSessionId: "parent",
    },
    frozenResultText:
      'Only backup completed.\n<cost_task_result>{"status":"partial","remaining":["Implement changes"],"blocker":null,"pendingRemoteTasks":[],"safeToResume":true}</cost_task_result>',
  };
}
function setup(run = entry()) {
  let current = true;
  let allowed = true;
  const dispatch = vi.fn(async (runId: string) => ({ runId }));
  const options = {
    entry: run,
    now: () => 10_000,
    isCurrent: () => current,
    inspect: vi.fn(async () => true),
    reserve: vi.fn((_id: string, _seconds: number) => {
      current = false;
      return true;
    }),
    dispatch,
    isAllowed: () => allowed,
    confirmed: vi.fn(),
    cancelled: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  return {
    options,
    dispatch,
    stop: () => {
      allowed = false;
    },
    invalidate: () => {
      current = false;
    },
  };
}
describe("one bounded cost continuation", () => {
  it("reserves once before sending and uses only the remaining original budget", async () => {
    const { options, dispatch } = setup();
    expect(await continueCostTaskOnce(options)).toBe(true);
    expect(options.reserve).toHaveBeenCalledWith(expect.stringMatching(/^cost-continuation:/), 50);
    expect(options.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0],
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(options.confirmed).toHaveBeenCalledTimes(1);
    expect(await continueCostTaskOnce(options)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "non-cost",
    "already-continued",
    "cancelled",
    "expired",
    "error",
    "no-receipt",
    "unsafe",
    "pending",
    "blocked",
  ])("does not continue %s work", async (kind) => {
    const run = entry();
    if (kind === "non-cost") {
      run.costTask = undefined;
    }
    if (kind === "already-continued") {
      run.costTask!.continuations = 1;
    }
    if (kind === "cancelled") {
      run.costTask!.cancelled = true;
    }
    if (kind === "expired") {
      run.costTask!.deadlineAt = 10_000;
    }
    if (kind === "error") {
      run.outcome = { status: "error" };
    }
    if (kind === "no-receipt") {
      run.frozenResultText = "未完成，尚无硬阻塞";
    }
    if (kind === "unsafe") {
      run.frozenResultText = run.frozenResultText!.replace(
        '"safeToResume":true',
        '"safeToResume":false',
      );
    }
    if (kind === "pending") {
      run.frozenResultText = run.frozenResultText!.replace(
        '"pendingRemoteTasks":[]',
        '"pendingRemoteTasks":["existing-job"]',
      );
    }
    if (kind === "blocked") {
      run.frozenResultText = run.frozenResultText!.replace(
        '"blocker":null',
        '"blocker":"Permission needed"',
      );
    }
    const { options, dispatch } = setup(run);
    expect(await continueCostTaskOnce(options)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch if state changes while inspecting tool evidence", async () => {
    const s = setup();
    s.options.inspect.mockImplementation(async () => {
      s.invalidate();
      return true;
    });
    expect(await continueCostTaskOnce(s.options)).toBe(false);
    expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch without a durable reservation", async () => {
    const s = setup();
    s.options.reserve.mockReturnValue(false);
    expect(await continueCostTaskOnce(s.options)).toBe(false);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it("keeps inspection failures from losing completion delivery or dispatching work", async () => {
    const s = setup();
    s.options.inspect.mockRejectedValue(new Error("operational evidence unavailable"));
    expect(await continueCostTaskOnce(s.options)).toBe(false);
    expect(s.options.reserve).not.toHaveBeenCalled();
    expect(s.dispatch).not.toHaveBeenCalled();
  });
  it("cancels a late accepted continuation after a user stop", async () => {
    const s = setup();
    s.dispatch.mockImplementation(async (runId) => {
      s.stop();
      return { runId };
    });
    expect(await continueCostTaskOnce(s.options)).toBe(true);
    expect(s.options.cancelled).toHaveBeenCalledTimes(1);
    expect(s.options.confirmed).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous dispatch and invokes failure handling", async () => {
    const s = setup();
    s.dispatch.mockRejectedValue(new Error("RPC lost"));
    expect(await continueCostTaskOnce(s.options)).toBe(true);
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    expect(s.options.failed).toHaveBeenCalledTimes(1);
  });
});

describe("settled operational evidence", () => {
  const call = (id: string, name: string, args = {}) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  });
  const result = (id: string, name: string, payload: object) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
  it("keeps an existing remote job pending until the same job is observed terminal", () => {
    const pending = [
      call("one", "remote_run"),
      result("one", "remote_run", { status: "running", task_id: "job" }),
    ];
    expect(hasUnsettledCostTools(pending)).toBe(true);
    expect(
      hasUnsettledCostTools([
        ...pending,
        call("two", "remote_task_result", { task_id: "job" }),
        result("two", "remote_task_result", { status: "completed", task_id: "job", exit_code: 0 }),
      ]),
    ).toBe(false);
  });
  it("fails closed on incomplete or opaque operational history", () => {
    expect(hasUnsettledCostTools([])).toBe(true);
    expect(hasUnsettledCostTools([call("one", "remote_run")])).toBe(true);
    expect(
      hasUnsettledCostTools([
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "one",
          content: [{ type: "text", text: "output truncated" }],
        },
      ]),
    ).toBe(true);
  });
  it("accepts terminal local exec details and ordinary read tools", () => {
    expect(
      hasUnsettledCostTools([
        call("one", "exec"),
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "one",
          details: { status: "completed", exitCode: 0 },
        },
      ]),
    ).toBe(false);
    expect(
      hasUnsettledCostTools([
        call("one", "read"),
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "one",
          content: [{ type: "text", text: "a file" }],
        },
      ]),
    ).toBe(false);
  });
});

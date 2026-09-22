import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelBackgroundCompaction,
  getBackgroundCompactionStatus,
} from "./background-compaction-state.js";
import {
  collectProtectedContext,
  commitReadyBackgroundCompaction,
  estimateBackgroundContextTokens,
  prepareBackgroundCompaction,
  scheduleBackgroundCompaction,
  type BackgroundCompactionParams,
} from "./background-compaction.js";

const summarize = vi.hoisted(() => vi.fn());
vi.mock("./background-compaction-model.js", () => ({ summarizeBackgroundContext: summarize }));
const summary =
  "## Decisions\n保留唯一索引。\n## Open TODOs\n继续验证。\n## Constraints/Rules\n生产只读。\n## Pending user asks\n不要上线。\n## Exact identifiers\nload_only";

describe("background compaction native transcript lifecycle", () => {
  let dir: string;
  let manager: SessionManager;
  let params: BackgroundCompactionParams;
  function append(text: string, tokens = 16_000) {
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Recorded" }],
      api: "openai-completions",
      provider: "test",
      model: "luna",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: tokens,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens + 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  beforeEach(async () => {
    summarize.mockReset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-compaction-test-"));
    manager = SessionManager.create(dir, dir);
    append("生产只读，不要上线。保留 /workspace/atlas/repro.py\n" + "observation ".repeat(1000));
    for (let i = 0; i < 4; i++) {
      append(`history ${i}\n` + "observation ".repeat(1000));
    }
    append("latest request");
    params = {
      config: {
        agents: {
          defaults: {
            compaction: {
              model: "test/luna",
              keepRecentTokens: 128,
              background: { enabled: true, triggerRatio: 0.7, timeoutMs: 1000, retryDelayMs: 1000 },
            },
          },
        },
      },
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile()!,
      sessionManager: manager,
      tokenBudget: 20_000,
      agentDir: dir,
      provider: "test",
    };
  });
  afterEach(async () => {
    cancelBackgroundCompaction(params.sessionFile);
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns while the provider is pending, preserves concurrent turns, and reloads native compaction", async () => {
    let finish!: (value: string) => void;
    summarize.mockImplementation((request: { onModelSelected?: (model: string) => void }) => {
      request.onModelSelected?.("secondary/summary");
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    expect(scheduleBackgroundCompaction(params)).toBe(true);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
    expect(scheduleBackgroundCompaction(params)).toBe(false);
    append("new fact BG-TAIL-7391; window cancelled");
    append("latest correction: must retain BG-CORRECTION-7392 verbatim");
    expect(manager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(0);
    finish(summary);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    expect(commitReadyBackgroundCompaction(params)).toBe(true);
    const reloaded = SessionManager.open(params.sessionFile);
    expect(reloaded.getSessionId()).toBe(params.sessionId);
    const text = JSON.stringify(reloaded.buildSessionContext().messages);
    expect(text).toContain("BG-TAIL-7391");
    expect(text).toContain("latest correction: must retain BG-CORRECTION-7392 verbatim");
    expect(text).toContain("生产只读");
    expect(text).not.toContain("history 0");
    expect(text.length).toBeLessThan(30_000);
    expect(reloaded.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(reloaded.getBranch().find((e) => e.type === "compaction")).toMatchObject({
      details: { model: "secondary/summary" },
    });
  });

  it("summarizes previous compaction plus retained/new messages on the second cycle", async () => {
    summarize.mockResolvedValue(summary);
    scheduleBackgroundCompaction(params);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    commitReadyBackgroundCompaction(params);
    append("newer history\n" + "extra ".repeat(3000));
    append("recent history\n" + "recent ".repeat(3000));
    append("newest fact");
    expect(scheduleBackgroundCompaction(params)).toBe(true);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
    const source = JSON.stringify(summarize.mock.calls[1][0].preparation.messagesToSummarize);
    expect(source).toContain("## Decisions");
    expect(source).toContain("newer history");
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    expect(commitReadyBackgroundCompaction(params)).toBe(true);
    expect(manager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(2);
  });

  it("rejects a result after branching or session reset", async () => {
    summarize.mockResolvedValue(summary);
    scheduleBackgroundCompaction(params);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    manager.branch(manager.getBranch()[1].id);
    append("different branch");
    expect(commitReadyBackgroundCompaction(params)).toBe(false);
    expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("idle");
  });

  it("does not overwrite newer foreground compaction", async () => {
    summarize.mockResolvedValue(summary);
    scheduleBackgroundCompaction(params);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    manager.appendCompaction("foreground won", manager.getBranch().at(-2)!.id, 16000);
    expect(commitReadyBackgroundCompaction(params)).toBe(false);
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("foreground won");
  });

  it("leaves original messages intact on provider failure and respects retry backoff", async () => {
    const before = manager.getBranch();
    summarize.mockRejectedValue(new Error("provider failure"));
    scheduleBackgroundCompaction(params);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("failed"),
    );
    expect(scheduleBackgroundCompaction(params)).toBe(false);
    expect(commitReadyBackgroundCompaction(params)).toBe(false);
    expect(manager.getBranch()).toEqual(before);
  });

  it("bounds a provider that ignores cancellation", async () => {
    summarize.mockImplementation(() => new Promise(() => {}));
    scheduleBackgroundCompaction(params);
    await vi.waitFor(
      () => expect(getBackgroundCompactionStatus(params.sessionFile).reason).toBe("timeout"),
      { timeout: 2000 },
    );
    expect(commitReadyBackgroundCompaction(params)).toBe(false);
  });

  it("keeps tool call/result pairing when cutting a large turn", async () => {
    manager.appendMessage({ role: "user", content: "run diagnostic", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "test" } }],
      api: "openai-completions",
      provider: "test",
      model: "luna",
      stopReason: "toolUse",
      timestamp: 1,
      usage: {
        input: 16000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "large result ".repeat(1000) }],
      isError: false,
      timestamp: 2,
    });
    summarize.mockResolvedValue(summary);
    expect(estimateBackgroundContextTokens(manager.buildSessionContext().messages)).toBeGreaterThan(
      14000,
    );
    expect(prepareBackgroundCompaction(manager.getBranch(), 128, 16000)).toBeDefined();
    expect(scheduleBackgroundCompaction(params)).toBe(true);
    await vi.waitFor(() =>
      expect(getBackgroundCompactionStatus(params.sessionFile).state).toBe("ready"),
    );
    commitReadyBackgroundCompaction(params);
    const context = manager.buildSessionContext().messages;
    const resultIndex = context.findIndex((m) => m.role === "toolResult");
    expect(resultIndex).toBeGreaterThan(0);
    expect(JSON.stringify(context[resultIndex - 1])).toContain("tool-1");
  });
});

it("does not silently discard oversized protected constraints", () => {
  expect(() =>
    collectProtectedContext([{ role: "user", content: "必须" + "x".repeat(25000), timestamp: 0 }]),
  ).toThrow("protected_context_too_large");
});

it("does not let stale imported usage undercut current history size", () => {
  const history = [
    { role: "user" as const, content: "imported history ".repeat(10000), timestamp: 0 },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "old answer" }],
      api: "openai-completions" as const,
      provider: "test",
      model: "test",
      stopReason: "stop" as const,
      timestamp: 1,
      usage: {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
  expect(estimateBackgroundContextTokens(history)).toBeGreaterThan(10000);
});

it("keeps exact identifiers without accumulating the surrounding assistant prose", () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({
    role: "assistant" as const,
    content: [
      {
        type: "text" as const,
        text: `Long explanation ${"details ".repeat(100)} /opt/work/flow.py TASK-42 variant ${i}`,
      },
    ],
    api: "openai-completions" as const,
    provider: "test",
    model: "test",
    stopReason: "stop" as const,
    timestamp: i,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }));
  const result = collectProtectedContext(messages);
  expect(result).toContain("/opt/work/flow.py");
  expect(result).toContain("TASK-42");
  expect(result).not.toContain("Long explanation");
  expect(result.length).toBeLessThan(200);
});

it("migrates previous protected prose and retains old and new user constraints verbatim", () => {
  const old =
    "summary\n<protected-context>\n必须只读操作，保留所有原始数据。\n" +
    Array.from(
      { length: 120 },
      (_, i) => `Explanation ${i} ${"details ".repeat(100)} /opt/work/flow.py`,
    ).join("\n") +
    "\n</protected-context>";
  const result = collectProtectedContext(
    [{ role: "user", content: "不要修改生产环境。", timestamp: 0 }],
    old,
  );
  expect(result).toContain("必须只读操作，保留所有原始数据。");
  expect(result).toContain("不要修改生产环境。");
  expect(result).toContain("/opt/work/flow.py");
  expect(result.length).toBeLessThan(300);
});

it("does not hit the protection limit by repeating paths already kept in constraints", () => {
  const constraints = Array.from(
    { length: 100 },
    (_, i) => `必须保留 /workspace/${"component".repeat(12)}/${i}/analysis.py`,
  );
  const text = collectProtectedContext([
    { role: "user", content: constraints.join("\n"), timestamp: 0 },
  ]);
  expect(text.length).toBeLessThan(24000);
  for (const line of constraints) {
    expect(text).toContain(line);
  }
  expect(collectProtectedContext([], text)).toBe(text);
});

it("preserves path spelling once without collapsing distinct opaque identifiers", () => {
  const text = collectProtectedContext([
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "/workspace/project /workspace/project/check.py check.py abcdef123456 abcdef1234567890",
        },
      ],
      timestamp: 0,
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ]);
  expect(text.split("\n")).toContain("/workspace/project/check.py");
  expect(text.split("\n")).not.toContain("/workspace/project");
  expect(text.split("\n")).not.toContain("check.py");
  expect(text.split("\n")).toContain("abcdef123456");
  expect(text.split("\n")).toContain("abcdef1234567890");
  expect(collectProtectedContext([], text)).toBe(text);
});

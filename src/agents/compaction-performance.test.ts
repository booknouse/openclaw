import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as pi from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCompactionDeadline } from "./compaction-budget.js";
import { summarizeInStages, summarizeWithFallback } from "./compaction.js";
import { applyPiAutoCompactionGuard } from "./pi-settings.js";

vi.mock("@mariozechner/pi-coding-agent", async (original) => ({
  ...(await original<typeof pi>()),
  generateSummary: vi.fn(),
}));
const generate = vi.mocked(pi.generateSummary);
const model = {
  id: "summary",
  provider: "test",
  contextWindow: 10000,
  maxTokens: 4096,
  reasoning: true,
} as Model<Api>;
const messages: AgentMessage[] = Array.from({ length: 4 }, (_, i) => ({
  role: "user",
  content: String(i).repeat(400),
  timestamp: i,
}));
const params = () => ({
  messages,
  model,
  apiKey: "test",
  signal: new AbortController().signal,
  reserveTokens: 20000,
  maxChunkTokens: 300,
  contextWindow: 10000,
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("bounded compaction work", () => {
  it("runs independent partitions concurrently and merges them in source order", async () => {
    let first!: (s: string) => void;
    let second!: (s: string) => void;
    generate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            second = resolve;
          }),
      )
      .mockResolvedValue("merged");
    const task = summarizeInStages(params());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    second("second partition");
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(2);
    first("first partition");
    await expect(task).resolves.toBe("merged");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2][0].map((m) => ("content" in m ? m.content : undefined))).toEqual([
      "first partition",
      "second partition",
    ]);
    expect(generate.mock.calls[0][1].reasoning).toBe(false);
    expect(Math.floor(generate.mock.calls[0][2] * 0.8)).toBeLessThanOrEqual(4096);
  });

  it("does not repeat identical input after a permanent provider error", async () => {
    generate.mockRejectedValue(new Error("401 invalid_api_key"));
    await expect(
      summarizeWithFallback({ ...params(), messages: messages.slice(0, 1) }),
    ).rejects.toThrow("401");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation without converting it into a successful fallback summary", async () => {
    generate.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(summarizeWithFallback(params())).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("returns on the total deadline even if a provider ignores abort", async () => {
    vi.useFakeTimers();
    let child!: AbortSignal;
    const task = withCompactionDeadline(
      new AbortController().signal,
      (signal) => {
        child = signal;
        return new Promise(() => {});
      },
      50,
    );
    const assertion = expect(task).rejects.toMatchObject({ name: "CompactionTimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(child.aborted).toBe(true);
  });

  it("never starts work for an already cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    await expect(withCompactionDeadline(controller.signal, run)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("disables Pi threshold compaction only when another mechanism owns compaction", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20000,
      getCompactionKeepRecentTokens: () => 8000,
      applyOverrides: vi.fn(),
      setCompactionEnabled: vi.fn(),
    };
    expect(applyPiAutoCompactionGuard({ settingsManager }).disabled).toBe(false);
    expect(settingsManager.setCompactionEnabled).not.toHaveBeenCalled();
    expect(
      applyPiAutoCompactionGuard({ settingsManager, backgroundCompaction: true }).disabled,
    ).toBe(true);
    expect(settingsManager.setCompactionEnabled).toHaveBeenCalledWith(false);
  });
});

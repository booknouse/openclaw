import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelIdleMemoryFlush, scheduleIdleMemoryFlush } from "./idle-memory-flush.js";

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const key of ["a", "b", "c"]) {
    await cancelIdleMemoryFlush(key);
  }
  vi.useRealTimers();
});

describe("idle memory maintenance", () => {
  it("does not block scheduling and cancels a pending flush on a new user turn", async () => {
    const run = vi.fn();
    scheduleIdleMemoryFlush({ key: "a", ready: () => true, run, onError: vi.fn() });
    expect(run).not.toHaveBeenCalled();
    await cancelIdleMemoryFlush("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it("waits until the foreground and background summary are idle, and deduplicates", async () => {
    let ready = false;
    const run = vi.fn().mockResolvedValue(undefined);
    const job = { key: "a", ready: () => ready, run, onError: vi.fn() };
    scheduleIdleMemoryFlush(job);
    scheduleIdleMemoryFlush(job);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts a running flush and settles it before admitting the next user turn", async () => {
    let signal!: AbortSignal;
    scheduleIdleMemoryFlush({
      key: "a",
      ready: () => true,
      onError: vi.fn(),
      run: (s) => {
        signal = s;
        return new Promise((resolve) =>
          s.addEventListener("abort", () => resolve(undefined), { once: true }),
        );
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(signal.aborted).toBe(false);
    await expect(cancelIdleMemoryFlush("a")).resolves.toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("bounds maintenance duration and global concurrency", async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
    });
    for (const key of ["a", "b", "c"]) {
      scheduleIdleMemoryFlush({ key, ready: () => true, run, onError: vi.fn() });
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

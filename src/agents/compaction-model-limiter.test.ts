import { describe, expect, it, vi } from "vitest";
import { CompactionModelLimiter } from "./compaction-model-limiter.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared compaction model concurrency", () => {
  it("routes four to primary, ten to secondary, and queues the fifteenth until primary frees", async () => {
    const limiter = new CompactionModelLimiter();
    const gates = Array.from({ length: 15 }, deferred);
    const selected: string[] = [];
    const pools = [
      { key: "primary", maxConcurrent: 4 },
      { key: "secondary", maxConcurrent: 10 },
    ];
    const tasks = gates.map((gate) =>
      limiter.run({
        signal: new AbortController().signal,
        pools,
        run: async (key) => {
          selected.push(key);
          await gate.promise;
        },
      }),
    );
    await vi.waitFor(() => expect(selected).toHaveLength(14));
    expect(selected).toEqual([
      ...Array.from({ length: 4 }, () => "primary"),
      ...Array.from({ length: 10 }, () => "secondary"),
    ]);
    gates[0].resolve();
    await vi.waitFor(() => expect(selected).toHaveLength(15));
    expect(selected[14]).toBe("primary");
    gates.forEach((gate) => gate.resolve());
    await Promise.all(tasks);
  });

  it("uses a secondary vacancy while primary stays full and honours custom limits", async () => {
    const limiter = new CompactionModelLimiter();
    const pools = [
      { key: "primary", maxConcurrent: 1 },
      { key: "secondary", maxConcurrent: 1 },
    ];
    const gates = Array.from({ length: 3 }, deferred);
    const selected: string[] = [];
    const tasks = gates.map((gate) =>
      limiter.run({
        signal: new AbortController().signal,
        pools,
        run: async (key) => {
          selected.push(key);
          await gate.promise;
        },
      }),
    );
    await vi.waitFor(() => expect(selected).toEqual(["primary", "secondary"]));
    gates[1].resolve();
    await vi.waitFor(() => expect(selected).toEqual(["primary", "secondary", "secondary"]));
    gates.forEach((gate) => gate.resolve());
    await Promise.all(tasks);
  });
  it("limits work from multiple sessions to two calls and admits queued work in order", async () => {
    const limiter = new CompactionModelLimiter();
    const gates = Array.from({ length: 6 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const tasks = gates.map((gate, i) =>
      limiter.run({
        signal: new AbortController().signal,
        maxConcurrent: 2,
        run: async () => {
          started.push(i);
          peak = Math.max(peak, ++active);
          await gate.promise;
          active--;
        },
      }),
    );
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates.forEach((gate) => gate.resolve());
    await Promise.all(tasks);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("removes cancelled queued work without invoking the provider", async () => {
    const limiter = new CompactionModelLimiter();
    const gate = deferred();
    const first = limiter.run({
      signal: new AbortController().signal,
      maxConcurrent: 1,
      run: () => gate.promise,
    });
    const controller = new AbortController();
    const run = vi.fn();
    const queued = limiter.run({ signal: controller.signal, maxConcurrent: 1, run });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    gate.resolve();
    await first;
    expect(run).not.toHaveBeenCalled();
    await expect(
      limiter.run({ signal: new AbortController().signal, run: async () => "next" }),
    ).resolves.toBe("next");
  });

  it("retains an aborted provider's slot until that provider actually settles", async () => {
    const limiter = new CompactionModelLimiter();
    const gate = deferred();
    const controller = new AbortController();
    const firstRun = vi.fn(() => gate.promise);
    const first = limiter.run({ signal: controller.signal, maxConcurrent: 1, run: firstRun });
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    const secondRun = vi.fn(async () => "done");
    const second = limiter.run({
      signal: new AbortController().signal,
      maxConcurrent: 1,
      run: secondRun,
    });
    controller.abort();
    await Promise.resolve();
    expect(secondRun).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    await expect(second).resolves.toBe("done");
  });

  it("releases slots on provider errors and rejects already cancelled work", async () => {
    const limiter = new CompactionModelLimiter();
    await expect(
      limiter.run({
        signal: new AbortController().signal,
        maxConcurrent: 1,
        run: async () => {
          throw new Error("provider failed");
        },
      }),
    ).rejects.toThrow("provider failed");
    const run = vi.fn();
    await expect(limiter.run({ signal: AbortSignal.abort(), run })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(run).not.toHaveBeenCalled();
    await expect(
      limiter.run({ signal: new AbortController().signal, run: async () => 42 }),
    ).resolves.toBe(42);
  });
});

import { PRIMARY_COMPACTION_CONCURRENCY } from "./compaction-model-config.js";

export type CompactionModelPool = { key: string; maxConcurrent: number };
type Waiter = {
  signal: AbortSignal;
  pools: CompactionModelPool[];
  start: (key: string) => void;
  abort: () => void;
};

/** All sessions share model slots. A slot lasts until the actual provider settles. */
export class CompactionModelLimiter {
  private active = new Map<string, number>();
  private queue: Waiter[] = [];

  private drain() {
    // Preserve arrival order among callers competing for the same available pool.
    for (const waiter of this.queue) {
      if (waiter.signal.aborted) {
        waiter.abort();
        continue;
      }
      const pool = waiter.pools.find(
        (item) => (this.active.get(item.key) ?? 0) < item.maxConcurrent,
      );
      if (pool) {
        this.queue = this.queue.filter((item) => item !== waiter);
        waiter.start(pool.key);
      }
    }
  }

  async run<T>(params: {
    signal: AbortSignal;
    pools?: CompactionModelPool[];
    maxConcurrent?: number;
    run: (key: string) => Promise<T>;
  }): Promise<T> {
    params.signal.throwIfAborted();
    const pools = params.pools ?? [
      { key: "default", maxConcurrent: params.maxConcurrent ?? PRIMARY_COMPACTION_CONCURRENCY },
    ];
    if (
      !pools.length ||
      pools.some(
        (pool) => !pool.key || !Number.isInteger(pool.maxConcurrent) || pool.maxConcurrent < 1,
      )
    ) {
      throw new Error("compaction_model_invalid_pools");
    }
    if (this.queue.length >= 128) {
      throw new Error("compaction_model_queue_full");
    }
    const key = await new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        signal: params.signal,
        pools,
        start: (key) => {
          params.signal.removeEventListener("abort", waiter.abort);
          this.active.set(key, (this.active.get(key) ?? 0) + 1);
          resolve(key);
        },
        abort: () => {
          this.queue = this.queue.filter((item) => item !== waiter);
          params.signal.removeEventListener("abort", waiter.abort);
          reject(new DOMException("Compaction cancelled while queued", "AbortError"));
        },
      };
      params.signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
    try {
      params.signal.throwIfAborted();
      return await params.run(key);
    } finally {
      const active = (this.active.get(key) ?? 1) - 1;
      if (active) {
        this.active.set(key, active);
      } else {
        this.active.delete(key);
      }
      this.drain();
    }
  }
}

// Multiple dist entry chunks must still share one process-wide budget.
const LIMITER_KEY = Symbol.for("openclaw.compactionModelLimiter");
const globalState = globalThis as typeof globalThis & { [LIMITER_KEY]?: CompactionModelLimiter };
const limiter = (globalState[LIMITER_KEY] ??= new CompactionModelLimiter());
export const runCompactionModelCall = limiter.run.bind(limiter);

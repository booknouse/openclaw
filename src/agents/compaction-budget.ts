/** One bounded deadline for the entire compaction, including queueing and merging. */
export const COMPACTION_TIMEOUT_MS = 180_000;
export const MAX_COMPACTION_TIMEOUT_MS = 300_000;

export class CompactionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Context compaction timed out after ${timeoutMs}ms; history preserved.`);
    this.name = "CompactionTimeoutError";
  }
}

export async function withCompactionDeadline<T>(
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = COMPACTION_TIMEOUT_MS,
): Promise<T> {
  const budget = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(MAX_COMPACTION_TIMEOUT_MS, Math.floor(timeoutMs)))
    : COMPACTION_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(
        signal.reason instanceof CompactionTimeoutError
          ? signal.reason
          : new DOMException("Compaction cancelled", "AbortError"),
      );
  });
  signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new CompactionTimeoutError(budget)), budget);
  timer.unref?.();
  try {
    if (signal.aborted) {
      throw new DOMException("Compaction cancelled", "AbortError");
    }
    return await Promise.race([run(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}

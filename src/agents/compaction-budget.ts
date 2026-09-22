/** One deadline for the entire compaction, including provider retries and merging. */
export const COMPACTION_TIMEOUT_MS = 60_000;

export async function withCompactionDeadline<T>(
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = COMPACTION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new DOMException("Compaction cancelled or timed out", "AbortError"));
  });
  signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

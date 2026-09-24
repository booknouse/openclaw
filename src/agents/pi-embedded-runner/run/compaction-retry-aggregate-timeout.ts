/**
 * Wait for compaction retry completion with an aggregate timeout to avoid
 * holding a session lane indefinitely when retry resolution is lost.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
  isCompactionStillInFlight?: () => boolean;
}): Promise<{ timedOut: boolean }> {
  const timeoutMsRaw = params.aggregateTimeoutMs;
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1, Math.floor(timeoutMsRaw)) : 1;

  let timedOut = false;
  const waitPromise = params.waitForCompactionRetry().then(() => "done" as const);

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.race([
        waitPromise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      // An already-aborted caller can reject without subscribing to pending.
      // Teardown may then reject the compaction wait; keep that rejection handled.
      void pending.catch(() => {});
      const result = await params.abortable(pending);

      if (result === "done") {
        break;
      }

      // Keep extending the timeout window while compaction is actively running.
      // We only trigger the fallback timeout once compaction appears idle.
      if (params.isCompactionStillInFlight?.()) {
        continue;
      }

      timedOut = true;
      params.onTimeout?.();
      break;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return { timedOut };
}

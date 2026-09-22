type Job = {
  isolated?: boolean;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  task?: Promise<void>;
};
const jobs = new Map<string, Job>();
const MAX_PENDING = 128;
const MAX_RUNNING = 2;
let running = 0;

/** A new user turn takes priority over this session's internal maintenance. */
function takeAndAbort(key: string): Job | undefined {
  const job = jobs.get(key);
  if (!job) {
    return undefined;
  }
  if (!job.task) {
    jobs.delete(key);
  }
  clearTimeout(job.timer);
  job.controller.abort();
  return job;
}

export function abortIdleMemoryFlush(key: string): boolean {
  return Boolean(takeAndAbort(key));
}

export async function cancelIdleMemoryFlush(key: string): Promise<boolean> {
  const job = takeAndAbort(key);
  if (!job) {
    return false;
  }
  const wasRunning = Boolean(job.task);
  if (!job.isolated) {
    await job.task;
  }
  return wasRunning;
}

/** Start only after the reply, once the session and its background summary are idle. */
export function scheduleIdleMemoryFlush(params: {
  key: string;
  isolated?: boolean;
  ready: () => boolean;
  run: (signal: AbortSignal) => Promise<unknown>;
  onError: () => void;
}): void {
  if (jobs.has(params.key) || jobs.size >= MAX_PENDING) {
    return;
  }
  const job: Job = { controller: new AbortController(), isolated: params.isolated };
  const expiresAt = Date.now() + 5 * 60_000;
  jobs.set(params.key, job);
  const poll = () => {
    if (jobs.get(params.key) !== job || job.controller.signal.aborted) {
      return;
    }
    if (Date.now() >= expiresAt) {
      jobs.delete(params.key);
      return;
    }
    if (running >= MAX_RUNNING || !params.ready()) {
      job.timer = setTimeout(poll, 2_000);
      job.timer.unref?.();
      return;
    }
    running++;
    const deadline = setTimeout(() => job.controller.abort(), 30_000);
    deadline.unref?.();
    job.task = Promise.resolve()
      .then(() => {
        job.controller.signal.throwIfAborted();
        return params.run(job.controller.signal);
      })
      .then(
        () => {},
        () => {
          if (!job.controller.signal.aborted) {
            params.onError();
          }
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        running--;
        if (jobs.get(params.key) === job) {
          jobs.delete(params.key);
        }
      });
  };
  job.timer = setTimeout(poll, 2_000);
  job.timer.unref?.();
}

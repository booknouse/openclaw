import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginCompaction, endCompaction, getCompactionStatus } from "./compaction-status.js";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { setCompactionSafeguardRuntime } from "./pi-extensions/compaction-safeguard-runtime.js";

type Session = Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];
type Listener = Parameters<Session["subscribe"]>[0];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function fixture(throws = false) {
  const sessionId = randomUUID();
  const runId = randomUUID();
  let listener: Listener | undefined;
  let queuedListener: Listener | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const end = {
    type: "auto_compaction_end",
    aborted: true,
    willRetry: false,
  } as Parameters<Listener>[0];
  const abortCompaction = vi.fn(() => {
    if (throws) {
      throw new Error("abort failed");
    }
    queuedListener = listener;
    queueMicrotask(() => listener?.(end));
  });
  const onAgentEvent = vi.fn();
  const sessionManager = {} as Session["sessionManager"];
  const h = createSubscribedSessionHarness({
    sessionId,
    runId,
    sessionKey: `agent:test:tenant:test:web:${sessionId}`,
    onAgentEvent,
    sessionExtras: {
      sessionId,
      sessionManager,
      isCompacting: true,
      abortCompaction,
      subscribe: (fn) => {
        listener = fn;
        return unsubscribe;
      },
    },
  });
  cleanups.push(() => {
    h.subscription.unsubscribe();
    endCompaction(sessionId, `auto:${runId}`, "cancelled");
  });
  return {
    ...h,
    sessionId,
    runId,
    sessionManager,
    abortCompaction,
    unsubscribe,
    onAgentEvent,
    start: () => listener?.({ type: "auto_compaction_start" } as Parameters<Listener>[0]),
    end: (result?: object) =>
      listener?.({ ...end, aborted: !result, result } as Parameters<Listener>[0]),
    lateEnd: () => queuedListener?.(end),
  };
}

describe("compaction cancellation during subscription teardown", () => {
  it("releases the operation and rejects waiters before the asynchronous SDK end", async () => {
    const f = fixture();
    f.start();
    const pending = f.subscription.waitForCompactionRetry();
    f.subscription.unsubscribe();
    f.subscription.unsubscribe();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getCompactionStatus(f.sessionId)).toMatchObject({ state: "cancelled", blocking: false });
    expect(f.subscription.isCompactionInFlight()).toBe(false);
    expect(f.abortCompaction).toHaveBeenCalledTimes(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    const version = getCompactionStatus(f.sessionId).version;
    f.lateEnd();
    await Promise.resolve();
    expect(getCompactionStatus(f.sessionId).version).toBe(version);
    expect(
      f.onAgentEvent.mock.calls.filter(
        ([e]) => e.stream === "compaction" && e.data.phase === "end",
      ),
    ).toHaveLength(1);
  });

  it("closes an observed operation even if the SDK already stopped compacting", () => {
    const f = fixture();
    f.start();
    Object.defineProperty(f.session, "isCompacting", { value: false });
    f.subscription.unsubscribe();
    expect(f.abortCompaction).not.toHaveBeenCalled();
    expect(getCompactionStatus(f.sessionId)).toMatchObject({ state: "cancelled", blocking: false });
  });

  it("does not change a successfully completed operation during ordinary teardown", () => {
    const f = fixture();
    f.start();
    f.end({ summary: "committed" });
    const before = getCompactionStatus(f.sessionId);
    f.subscription.unsubscribe();
    expect(getCompactionStatus(f.sessionId)).toEqual(before);
    expect(before.state).toBe("succeeded");
    expect(f.subscription.getCompactionCount()).toBe(1);
  });

  it("preserves an outer operation and another session's lock", () => {
    const f = fixture();
    const other = randomUUID();
    beginCompaction(f.sessionId, undefined, "outer");
    beginCompaction(other, undefined, "other");
    cleanups.push(() => {
      endCompaction(f.sessionId, "outer", "cancelled");
      endCompaction(other, "other", "cancelled");
    });
    f.start();
    f.subscription.unsubscribe();
    expect(getCompactionStatus(f.sessionId).blocking).toBe(true);
    expect(getCompactionStatus(other).blocking).toBe(true);
    endCompaction(f.sessionId, "outer", "succeeded");
    expect(getCompactionStatus(f.sessionId).blocking).toBe(false);
  });

  it("retains the timeout failure rather than calling it user cancellation", () => {
    const f = fixture();
    f.start();
    setCompactionSafeguardRuntime(f.sessionManager, {
      failure: { code: "compaction_timeout", message: "deadline" },
    });
    f.subscription.unsubscribe();
    expect(getCompactionStatus(f.sessionId)).toMatchObject({ state: "failed", blocking: false });
    expect(f.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: expect.objectContaining({
        phase: "end",
        outcome: "failed",
        errorCode: "compaction_timeout",
      }),
    });
  });

  it("still closes status and removes the listener if SDK abort throws", () => {
    const f = fixture(true);
    f.start();
    f.subscription.unsubscribe();
    expect(getCompactionStatus(f.sessionId)).toMatchObject({ state: "cancelled", blocking: false });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not invent a compaction end when no start was observed", () => {
    const f = fixture();
    f.subscription.unsubscribe();
    expect(getCompactionStatus(f.sessionId)).toMatchObject({ state: "idle", blocking: false });
    expect(f.onAgentEvent).not.toHaveBeenCalled();
  });
});

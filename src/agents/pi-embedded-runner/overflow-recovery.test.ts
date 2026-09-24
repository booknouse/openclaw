import { describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { runWithOverflowRecovery } from "./overflow-recovery.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: vi.fn() }));
const params = () =>
  ({ runId: "run-recovery", onAgentEvent: vi.fn() }) as unknown as RunEmbeddedPiAgentParams;

describe("overflow recovery terminal ownership", () => {
  it("waits through compaction and never duplicates a successful final", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    const p = params();
    const result = await runWithOverflowRecovery(p, async (inner) => {
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "recovering" } });
      expect(emitAgentEvent).not.toHaveBeenCalled();
      inner.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", outcome: "succeeded", willRetry: true },
      });
      expect(emitAgentEvent).not.toHaveBeenCalled();
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "end" } });
      return { meta: { durationMs: 100 }, payloads: [{ text: "original answer" }] };
    });
    expect(result.payloads?.[0].text).toBe("original answer");
    expect(emitAgentEvent).not.toHaveBeenCalled();
    expect(p.onAgentEvent).toHaveBeenCalledTimes(3);
  });

  it("turns an SDK-cancelled compaction into one precise terminal failure, never an old answer", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    const result = await runWithOverflowRecovery(params(), async (inner) => {
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "recovering" } });
      inner.onAgentEvent?.({
        stream: "compaction",
        data: {
          phase: "end",
          outcome: "failed",
          errorCode: "compaction_timeout",
          error: "Context compaction timed out; history preserved.",
        },
      });
      return { meta: { durationMs: 180000 }, payloads: [{ text: "old historical assistant" }] };
    });
    expect(result.meta.error?.kind).toBe("compaction_failure");
    expect(result.payloads?.[0].isError).toBe(true);
    expect(result.payloads?.[0].text).not.toContain("old historical");
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: "error", errorCode: "compaction_timeout" }),
      }),
    );
  });

  it("emits final failure when retries are exhausted, after all recovering events", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await runWithOverflowRecovery(params(), async (inner) => {
      for (let i = 0; i < 3; i++) {
        inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "recovering" } });
        expect(emitAgentEvent).not.toHaveBeenCalled();
      }
      return {
        meta: { durationMs: 50, error: { kind: "context_overflow", message: "still too large" } },
      };
    });
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit cancellation distinct from timeout failure", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await runWithOverflowRecovery(params(), async (inner) => {
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "recovering" } });
      inner.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", outcome: "cancelled", willRetry: false },
      });
      return { meta: { durationMs: 10, aborted: true } };
    });
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "context_recovery_aborted" }),
      }),
    );
  });

  it("preserves ordinary errors without extra terminal events", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await expect(
      runWithOverflowRecovery(params(), async () => {
        throw new Error("auth failed");
      }),
    ).rejects.toThrow("auth failed");
    expect(emitAgentEvent).not.toHaveBeenCalled();
  });

  it("terminates explicitly if the caller aborts during recovery", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await runWithOverflowRecovery(params(), async (inner) => {
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "recovering" } });
      return { meta: { durationMs: 10, aborted: true } };
    });
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "context_recovery_aborted" }),
      }),
    );
  });
});

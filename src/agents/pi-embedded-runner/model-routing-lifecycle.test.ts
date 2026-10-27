import { describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { runWithModelRoutingLifecycle } from "./model-routing-lifecycle.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: vi.fn() }));
const params = () =>
  ({ runId: "cost-run", onAgentEvent: vi.fn() }) as unknown as RunEmbeddedPiAgentParams;
describe("cost model fallback terminal ownership", () => {
  it("keeps the request open for fallback and never duplicates a successful final", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    const p = params();
    await runWithModelRoutingLifecycle(p, async (inner) => {
      expect(inner.modelRoutingFallback).toBe(true);
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "model_fallback" } });
      expect(emitAgentEvent).not.toHaveBeenCalled();
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "end" } });
      return { meta: { durationMs: 1 }, payloads: [{ text: "primary result" }] };
    });
    expect(emitAgentEvent).not.toHaveBeenCalled();
    expect(p.onAgentEvent).toHaveBeenCalledTimes(2);
  });
  it("emits exactly one terminal error if both models fail", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await expect(
      runWithModelRoutingLifecycle(params(), async (inner) => {
        inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "model_fallback" } });
        throw new Error("both models unavailable");
      }),
    ).rejects.toThrow("both models unavailable");
    expect(emitAgentEvent).toHaveBeenCalledTimes(1);
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: "error", errorCode: "model_routing_failed" }),
      }),
    );
  });
  it("retains precise compaction failure and cancellation terminals", async () => {
    vi.mocked(emitAgentEvent).mockClear();
    await runWithModelRoutingLifecycle(params(), async (inner) => {
      inner.onAgentEvent?.({ stream: "lifecycle", data: { phase: "model_fallback" } });
      inner.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "error", errorCode: "protected_context_too_large" },
      });
      return {
        meta: {
          durationMs: 1,
          error: { kind: "compaction_failure", message: "protected_context_too_large" },
        },
      };
    });
    expect(emitAgentEvent).not.toHaveBeenCalled();
  });
});

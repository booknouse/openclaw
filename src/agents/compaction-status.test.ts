import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { beginCompaction, endCompaction, getCompactionStatus } from "./compaction-status.js";

it("isolates native sessions and rejects stale end operations", () => {
  const a = randomUUID();
  const b = randomUUID();
  const first = beginCompaction(a, "agent:alice:tenant:alice:web:A");
  expect(getCompactionStatus(a).blocking).toBe(true);
  expect(getCompactionStatus(b).blocking).toBe(false);
  endCompaction(a, first, "succeeded");
  const second = beginCompaction(a, "agent:alice:tenant:alice:web:A");
  endCompaction(a, first, "failed");
  expect(getCompactionStatus(a).blocking).toBe(true);
  endCompaction(a, second, "cancelled");
  expect(getCompactionStatus(a)).toMatchObject({ blocking: false, state: "cancelled" });
});

it("keeps the outer manual lock while its inner automatic compaction finishes", () => {
  const id = randomUUID();
  const outer = beginCompaction(id);
  const inner = beginCompaction(id);
  endCompaction(id, inner, "succeeded");
  expect(getCompactionStatus(id).blocking).toBe(true);
  endCompaction(id, outer, "failed");
  expect(getCompactionStatus(id)).toMatchObject({ blocking: false, state: "failed" });
});

it("publishes the exact owning session key with monotonically increasing state revisions", () => {
  const events: Array<{ sessionKey?: string; data: Record<string, unknown> }> = [];
  const stop = onAgentEvent((event) => {
    if (event.stream === "context_status") {
      events.push(event);
    }
  });
  try {
    const id = randomUUID();
    const key = "agent:virtual:tenant:alice:web:A:runtime:r1";
    const op = beginCompaction(id, key);
    endCompaction(id, op, "succeeded");
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.sessionKey === key && event.data.sessionId === id)).toBe(
      true,
    );
    const start = events[0].data.compaction as { version: number };
    const end = events[1].data.compaction as { version: number };
    expect(end.version).toBeGreaterThan(start.version);
  } finally {
    stop();
  }
});

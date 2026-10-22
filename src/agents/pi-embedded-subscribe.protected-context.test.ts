import type { AssistantMessage } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { setCompactionSafeguardRuntime } from "./pi-extensions/compaction-safeguard-runtime.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type Session = Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

it.each(["protected_context_too_large", "protected_context_evidence_unavailable"])(
  "stops the enclosing provider guard and reports %s without erasing usage",
  (code) => {
    const controller = new AbortController();
    const onCompactionBlocked = vi.fn(() => controller.abort(new Error(code)));
    const onAgentEvent = vi.fn();
    const manager = {} as Session["sessionManager"];
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: 0,
      usage: { ...makeZeroUsageSnapshot(), input: 260000, totalTokens: 260000 },
    };
    const h = createSubscribedSessionHarness({
      runId: `test-${code}`,
      onCompactionBlocked,
      onAgentEvent,
      sessionExtras: { sessionManager: manager, messages: [message] },
    });
    try {
      setCompactionSafeguardRuntime(manager, {
        failure: { code, message: "History preserved; review constraints before continuing." },
      });
      h.emit({ type: "auto_compaction_start" });
      h.emit({ type: "auto_compaction_end", aborted: true, willRetry: false });
      expect(controller.signal.aborted).toBe(true);
      expect(onCompactionBlocked).toHaveBeenCalledOnce();
      expect(message.usage.input).toBe(260000);
      expect(h.subscription.getCompactionCount()).toBe(0);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "compaction",
        data: expect.objectContaining({ outcome: "failed", errorCode: code }),
      });
    } finally {
      h.subscription.unsubscribe();
    }
  },
);

it("does not abort a successful compaction and clears only its stale usage", () => {
  const onCompactionBlocked = vi.fn();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 0,
    usage: { ...makeZeroUsageSnapshot(), input: 260000, totalTokens: 260000 },
  };
  const h = createSubscribedSessionHarness({
    runId: "protected-success",
    onCompactionBlocked,
    sessionExtras: { messages: [message] },
  });
  try {
    h.emit({ type: "auto_compaction_end", willRetry: false, result: { summary: "complete" } });
    expect(onCompactionBlocked).not.toHaveBeenCalled();
    expect(message.usage.input).toBe(0);
    expect(h.subscription.getCompactionCount()).toBe(1);
  } finally {
    h.subscription.unsubscribe();
  }
});

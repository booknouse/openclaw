import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedEnsureRuntimePluginsLoaded = vi.mocked(ensureRuntimePluginsLoaded);

describe("runEmbeddedPiAgent usage reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sender-forwarding",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      senderE164: "+15551234567",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "user-123",
        senderName: "Josh Lehman",
        senderUsername: "josh",
        senderE164: "+15551234567",
      }),
    );
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "flush",
      timeoutMs: 30000,
      runId: "run-memory-forwarding",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-10.md",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-03-10.md",
      }),
    );
  });

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: false,
      promptError: null,
      timedOut: false,
      sessionIdUsed: "test-session",
      assistantTexts: ["Response 1", "Response 2"],
      lastAssistant: {
        usage: { input: 150, output: 50, total: 200 },
        stopReason: "end_turn",
      },
      attemptUsage: { input: 250, output: 100, total: 350 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage).toBeDefined();

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
  });

  it.each(["protected_context_too_large", "protected_context_evidence_unavailable"])(
    "returns %s explicitly with no reply or usage from history when no model ran",
    async (code) => {
      const historical = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "old response" }],
        usage: { input: 63000, output: 10, total: 63010 },
      };
      mockedRunEmbeddedAttempt.mockResolvedValueOnce({
        aborted: true,
        timedOut: false,
        timedOutDuringCompaction: false,
        promptError: new Error("aborted"),
        sessionIdUsed: "test-session",
        messagesSnapshot: [historical],
        assistantTexts: [],
        toolMetas: [],
        lastAssistant: undefined,
        compactionFailure: { code, message: `${code}: history preserved` },
      } as unknown as Awaited<ReturnType<typeof runEmbeddedAttempt>>);

      const result = await runEmbeddedPiAgent({
        sessionId: "test-session",
        sessionKey: "test-key",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 30000,
        runId: `run-${code}`,
      });

      expect(result.meta.aborted).toBe(true);
      expect(result.meta.agentMeta?.usage).toBeUndefined();
      expect(result.meta.agentMeta?.lastCallUsage).toBeUndefined();
      expect(result.meta.agentMeta?.promptTokens).toBeUndefined();
      expect(result.payloads).toEqual([{ text: `${code}: history preserved`, isError: true }]);
      expect(result.meta.error).toEqual({
        kind: "compaction_failure",
        message: `${code}: history preserved`,
      });
      expect(historical.usage.input).toBe(63000);
    },
  );

  it("preserves the current reply and paid usage when protection stops a later model call", async () => {
    const failure = {
      code: "protected_context_too_large",
      message: "protected_context_too_large: history preserved",
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce({
      aborted: true,
      timedOut: false,
      timedOutDuringCompaction: false,
      promptError: new Error("aborted"),
      sessionIdUsed: "test-session",
      assistantTexts: ["current response"],
      toolMetas: [],
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "current response" }],
        usage: { input: 100, output: 10, total: 110 },
        stopReason: "stop",
      },
      attemptUsage: { input: 100, output: 10, total: 110 },
      compactionFailure: failure,
    } as unknown as Awaited<ReturnType<typeof runEmbeddedAttempt>>);

    vi.mocked(buildEmbeddedRunPayloads).mockReturnValueOnce([{ text: "current response" }]);

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-protection-after-response",
    });

    expect(result.meta.agentMeta?.usage).toMatchObject({ input: 100, output: 10, total: 110 });
    expect(result.payloads).toEqual([
      expect.objectContaining({ text: "current response" }),
      { text: failure.message, isError: true },
    ]);
  });
});

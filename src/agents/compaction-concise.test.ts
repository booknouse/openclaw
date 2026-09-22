import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { compactionSummaryFits, generateCompactionSummary } from "./compaction-summary.js";
import { summarizeInStages } from "./compaction.js";

vi.mock("@mariozechner/pi-ai", async (original) => ({
  ...(await original<typeof import("@mariozechner/pi-ai")>()),
  completeSimple: vi.fn(),
}));
const complete = vi.mocked(completeSimple);
const summary =
  "## Decisions\nKeep the fix.\n## Open TODOs\nVerify.\n## Constraints/Rules\nRead only.\n## Pending user asks\nContinue.\n## Exact identifiers\nTASK-123";
const model = {
  id: "concise",
  provider: "test",
  api: "openai-completions",
  contextWindow: 270000,
  maxTokens: 4096,
} as Model<Api>;
function response(text = summary) {
  return { stopReason: "stop", content: [{ type: "text", text }] } as Awaited<
    ReturnType<typeof completeSimple>
  >;
}
function params() {
  return {
    messages: Array.from({ length: 8 }, (_, i) => ({
      role: "user",
      content: `task ${i}: ${"data ".repeat(100)}`,
      timestamp: i,
    })) as AgentMessage[],
    model,
    apiKey: "test-key",
    signal: new AbortController().signal,
    reserveTokens: 20000,
    maxChunkTokens: 100,
    contextWindow: 270000,
    previousSummary: "Earlier decision: preserve TASK-123",
    concise: true,
  };
}
afterEach(() => vi.resetAllMocks());

it("summarizes a fitting native history in one call including the previous summary", async () => {
  complete.mockResolvedValue(response());
  await expect(summarizeInStages(params())).resolves.toBe(summary);
  expect(complete).toHaveBeenCalledOnce();
  const prompt = JSON.stringify(complete.mock.calls[0][1]);
  expect(prompt).toContain("Earlier decision: preserve TASK-123");
  expect(prompt).toContain("task 0");
  expect(prompt).toContain("task 7");
  expect(complete.mock.calls[0][0].reasoning).toBe(false);
  expect(complete.mock.calls[0][1]).not.toHaveProperty("tools");
});

it("retains staged summarization when the serialized input cannot fit", async () => {
  complete.mockResolvedValue(response());
  const p = params();
  p.messages = Array.from({ length: 8 }, () => ({
    role: "user",
    content: "large data ".repeat(1000),
    timestamp: 0,
  }));
  p.contextWindow = 10000;
  p.maxChunkTokens = 4000;
  expect(compactionSummaryFits(p, p.contextWindow)).toBe(false);
  await expect(summarizeInStages(p)).resolves.toBe(summary);
  expect(complete.mock.calls.length).toBeGreaterThan(1);
  for (const call of complete.mock.calls) {
    expect(call[1].systemPrompt).toContain("compact continuation checkpoint");
  }
});

it("budgets the previous summary and custom instructions before choosing one call", () => {
  const p = params();
  expect(compactionSummaryFits(p, 10000)).toBe(true);
  expect(compactionSummaryFits({ ...p, previousSummary: "previous ".repeat(10000) }, 10000)).toBe(
    false,
  );
  expect(
    compactionSummaryFits({ ...p, customInstructions: "instructions ".repeat(10000) }, 10000),
  ).toBe(false);
});

it("uses the shared model runner for native compaction", async () => {
  complete.mockResolvedValue(response());
  const runSummary = vi.fn(async (_signal, run) =>
    run({ ...model, id: "secondary" }, "secondary-key"),
  );
  await summarizeInStages({ ...params(), runSummary });
  expect(runSummary).toHaveBeenCalledOnce();
  expect(complete.mock.calls[0][0].id).toBe("secondary");
  expect(complete.mock.calls[0][2]?.apiKey).toBe("secondary-key");
});

it("rejects a late successful response after the caller cancels", async () => {
  const controller = new AbortController();
  complete.mockImplementation(async () => {
    controller.abort();
    return response();
  });
  await expect(
    generateCompactionSummary({ ...params(), signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("strips tool-result details from the shared generator input", async () => {
  complete.mockResolvedValue(response());
  const messages: AgentMessage[] = [
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "visible evidence" }],
      details: { secret: "DO_NOT_INCLUDE_DETAILS" },
      isError: false,
      timestamp: 0,
    },
  ];
  await generateCompactionSummary({ ...params(), messages });
  const prompt = JSON.stringify(complete.mock.calls[0][1]);
  expect(prompt).toContain("visible evidence");
  expect(prompt).not.toContain("DO_NOT_INCLUDE_DETAILS");
});

it.each(["off", "custom"] as const)(
  "honors the native %s identifier policy in the shared generator",
  async (identifierPolicy) => {
    complete.mockResolvedValue(response());
    await summarizeInStages({
      ...params(),
      summarizationInstructions: {
        identifierPolicy,
        identifierInstructions: "Keep active task identifiers only",
      },
    });
    const prompt = complete.mock.calls[0][1].systemPrompt;
    expect(prompt).not.toContain("exact identifiers and validated workflows");
    expect(prompt).toContain(
      identifierPolicy === "off"
        ? "do not produce an identifier inventory"
        : "Follow the configured identifier instructions",
    );
  },
);

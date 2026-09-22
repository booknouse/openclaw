import type { Model } from "@mariozechner/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { generateCompactionSummary } from "./compaction-summary.js";

const summary =
  "## Decisions\nKeep.\n## Open TODOs\nVerify.\n## Constraints/Rules\nRead only.\n## Pending user asks\nContinue.\n## Exact identifiers\nTASK-1";
function mockResponse(model: string) {
  const chunks = [
    {
      id: "summary",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: summary }, finish_reason: null }],
    },
    {
      id: "summary",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
const qwen = {
  id: "qwen3.5-flash",
  name: "Qwen",
  provider: "aliyun-bailian",
  api: "openai-completions",
  baseUrl: "https://dashscope.example.test/compatible-mode/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 1000000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

afterEach(() => vi.unstubAllGlobals());

it.each([
  { reasoning: false, compat: undefined },
  { reasoning: false, compat: { thinkingFormat: "qwen" as const } },
  { reasoning: true, compat: { thinkingFormat: "qwen" as const } },
  { id: "summary-alias", reasoning: false, compat: { thinkingFormat: "qwen" as const } },
  { id: "qwen3.5-flash-2026-02-23", reasoning: false, compat: undefined },
])("sends explicit non-thinking Qwen compaction payload for %j", async (overrides) => {
  const model = { ...qwen, ...overrides };
  const captured: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://dashscope.example.test/compatible-mode/v1/chat/completions",
      );
      captured.push((await request.json()) as Record<string, unknown>);
      return mockResponse(model.id);
    }),
  );
  await expect(
    generateCompactionSummary({
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      messages: [{ role: "user", content: "Summarize the current task.", timestamp: 0 }],
    }),
  ).resolves.toBe(summary);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ model: model.id, enable_thinking: false });
  expect(captured[0].max_tokens ?? captured[0].max_completion_tokens).toBe(4096);
  expect(captured[0]).not.toHaveProperty("reasoning_effort");
  expect(captured[0]).not.toHaveProperty("tools");
  expect(model.reasoning).toBe(overrides.reasoning);
});

it("does not send the Qwen-specific field to other summary models", async () => {
  const captured: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push((await new Request(input, init).json()) as Record<string, unknown>);
      return mockResponse("gpt-5.6-luna");
    }),
  );
  await generateCompactionSummary({
    model: { ...qwen, id: "gpt-5.6-luna", provider: "ddww" },
    apiKey: "test-key",
    signal: new AbortController().signal,
    messages: [{ role: "user", content: "Keep the constraints.", timestamp: 0 }],
  });
  expect(captured).toHaveLength(1);
  expect(captured[0]).not.toHaveProperty("enable_thinking");
});

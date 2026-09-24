import type { Api, Model } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { summarizeBackgroundContext } from "./background-compaction-model.js";
import { resolveCompactionModel } from "./compaction-model.runtime.js";
import { summarizeWithFallback } from "./compaction.js";

const mocks = vi.hoisted(() => ({ summary: vi.fn(), complete: vi.fn(), auth: vi.fn() }));
vi.mock("@mariozechner/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@mariozechner/pi-coding-agent")>()),
  generateSummary: mocks.summary,
}));
vi.mock("@mariozechner/pi-ai", async (original) => ({
  ...(await original<typeof import("@mariozechner/pi-ai")>()),
  completeSimple: mocks.complete,
}));
vi.mock("./model-auth.js", () => ({ getApiKeyForModel: mocks.auth }));
vi.mock("./models-config.js", () => ({ ensureOpenClawModelsJson: async () => {} }));
vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: (provider: string, id: string) => ({
    model: {
      provider,
      id,
      api: "openai-completions",
      contextWindow: provider === "primary" ? 30000 : 10000,
      maxTokens: 2048,
      reasoning: true,
    } as Model<Api>,
  }),
}));

it("shares primary and secondary capacity across synchronous and background summary entry points", async () => {
  const cfg = {
    agents: {
      defaults: {
        compaction: {
          models: {
            primary: { model: "primary/summary", maxConcurrent: 1 },
            secondary: { model: "secondary/summary", maxConcurrent: 1 },
          },
          background: { enabled: true },
        },
      },
    },
  };
  mocks.auth.mockImplementation(async ({ model }) => ({ apiKey: model.provider + "-key" }));
  let finishFirst!: (value: string) => void;
  let finishBackground!: (value: unknown) => void;
  mocks.summary
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValue("next summary");
  mocks.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishBackground = resolve;
      }),
  );
  const resolved = await resolveCompactionModel({
    cfg,
    provider: "dialogue",
    agentId: "xuebing",
    authProfileId: "dialogue-profile",
  });
  expect(resolved.contextWindow).toBe(10000);
  expect(resolved.model.headers?.["User-Agent"]).toContain(" OpenClaw-Agent/xuebing");
  const signal = new AbortController().signal;
  const params = {
    messages: [{ role: "user" as const, content: "Preserve this fact", timestamp: 1 }],
    model: resolved.model,
    apiKey: resolved.apiKey,
    signal,
    reserveTokens: 10000,
    maxChunkTokens: 1000,
    contextWindow: resolved.contextWindow,
    runSummary: resolved.runSummary,
  };
  const sync = summarizeWithFallback(params);
  await vi.waitFor(() => expect(mocks.summary).toHaveBeenCalledOnce());
  const selected = vi.fn();
  const background = summarizeBackgroundContext({
    onModelSelected: selected,
    sessionKey: "agent:wusy:tenant:wusy:web:test:role:user",
    sessionId: "test-session",
    sessionFile: "/test/session.jsonl",
    tokenBudget: 30000,
    sessionManager: { getBranch: vi.fn(), buildSessionContext: vi.fn(), appendCompaction: vi.fn() },
    config: cfg,
    provider: "dialogue",
    agentDir: "/test/agent",
    authProfileId: "dialogue-profile",
    signal,
    preparation: {
      messagesToSummarize: params.messages,
      firstKeptEntryId: "kept",
      tokensBefore: 20000,
    },
  });
  await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
  expect(selected).toHaveBeenCalledWith("secondary/summary");
  expect(mocks.summary.mock.calls[0][1].headers["User-Agent"]).toContain(" OpenClaw-Agent/xuebing");
  expect(mocks.complete.mock.calls[0][0].headers["User-Agent"]).toContain(" OpenClaw-Agent/wusy");
  expect(mocks.summary.mock.calls[0][1]).toMatchObject({ provider: "primary", reasoning: false });
  expect(mocks.summary.mock.calls[0][3]).toBe("primary-key");
  expect(mocks.complete.mock.calls[0][0]).toMatchObject({
    provider: "secondary",
    reasoning: false,
  });
  expect(mocks.complete.mock.calls[0][2]).toMatchObject({
    apiKey: "secondary-key",
    maxTokens: 2048,
  });
  expect(mocks.auth.mock.calls.every(([request]) => request.profileId === undefined)).toBe(true);
  const queued = summarizeWithFallback(params);
  await Promise.resolve();
  expect(mocks.summary).toHaveBeenCalledOnce();
  finishFirst("first summary");
  await expect(sync).resolves.toBe("first summary");
  await expect(queued).resolves.toBe("next summary");
  expect(mocks.summary.mock.calls[1][1].provider).toBe("primary");
  finishBackground({
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: "## Decisions\na\n## Open TODOs\nb\n## Constraints/Rules\nc\n## Pending user asks\nd\n## Exact identifiers\ne",
      },
    ],
  });
  await expect(background).resolves.toContain("## Decisions");
});

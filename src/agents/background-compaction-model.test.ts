import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import { summarizeBackgroundContext } from "./background-compaction-model.js";

const f = vi.hoisted(() => ({ complete: vi.fn(), auth: vi.fn(), resolve: vi.fn() }));
vi.mock("@mariozechner/pi-ai", async (original) => ({
  ...(await original<typeof import("@mariozechner/pi-ai")>()),
  completeSimple: f.complete,
}));
vi.mock("./model-auth.js", () => ({ getApiKeyForModel: (...args: unknown[]) => f.auth(...args) }));
vi.mock("./models-config.js", () => ({ ensureOpenClawModelsJson: async () => {} }));
vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => f.resolve(...args),
}));
const params = {
  config: {
    agents: {
      defaults: { compaction: { model: "summary/gpt-5.6-luna", background: { enabled: true } } },
    },
  },
  agentDir: "/test/agent",
  provider: "chat",
  authProfileId: "chat-profile",
  preparation: {
    messagesToSummarize: [{ role: "user", content: "keep facts", timestamp: 0 }],
    firstKeptEntryId: "kept",
    tokensBefore: 10000,
  },
  signal: new AbortController().signal,
} as Parameters<typeof summarizeBackgroundContext>[0];
beforeEach(() => {
  f.complete.mockReset();
  f.auth.mockReset();
  f.resolve.mockReset();
  f.resolve.mockReturnValue({
    model: {
      id: "gpt-5.6-luna",
      provider: "summary",
      api: "openai-completions",
      reasoning: true,
    } as Model<"openai-completions">,
  });
  f.auth.mockResolvedValue({ apiKey: "test-only-key" });
  f.complete.mockResolvedValue({
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: "## Decisions\na\n## Open TODOs\nb\n## Constraints/Rules\nc\n## Pending user asks\nd\n## Exact identifiers\ne",
      },
    ],
  });
});
it("resolves the dedicated provider without reusing the dialogue auth profile", async () => {
  await summarizeBackgroundContext(params);
  expect(f.resolve).toHaveBeenCalledWith("summary", "gpt-5.6-luna", "/test/agent", params.config);
  expect(f.auth.mock.calls[0][0].profileId).toBeUndefined();
  expect(f.complete.mock.calls[0][0].reasoning).toBe(false);
  expect(f.complete.mock.calls[0][2]).toMatchObject({
    maxTokens: 4096,
    temperature: 0,
    signal: params.signal,
  });
  expect(f.complete.mock.calls[0][1]).not.toHaveProperty("tools");
});
it.each(["length", "error", "aborted"])("rejects incomplete %s responses", async (stopReason) => {
  f.complete.mockResolvedValue({ stopReason, content: [] });
  await expect(summarizeBackgroundContext(params)).rejects.toThrow(
    "background_compaction_incomplete",
  );
});
it("rejects a response that did not follow the summary schema", async () => {
  f.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "hello" }] });
  await expect(summarizeBackgroundContext(params)).rejects.toThrow(
    "background_compaction_invalid_format",
  );
});

import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCompactionModel } from "./compaction-model.runtime.js";
import { getApiKeyForModel } from "./model-auth.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

vi.mock("./model-auth.js", () => ({ getApiKeyForModel: vi.fn() }));
vi.mock("./pi-embedded-runner/model.js", () => ({ resolveModel: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(["other/summary", "summary"])(
  "resolves %s in the correct agent and provider auth scope",
  async (reference) => {
    const provider = reference.includes("/") ? "other" : "dialogue";
    const model = { id: "summary", provider } as Model<Api>;
    vi.mocked(resolveModel).mockReturnValue({ model } as ReturnType<typeof resolveModel>);
    vi.mocked(getApiKeyForModel).mockResolvedValue({
      apiKey: "summary-key",
      source: "test",
      mode: "api-key",
    });
    const cfg = { agents: { defaults: { compaction: { model: reference } } } };
    await expect(
      resolveCompactionModel({
        cfg,
        provider: "dialogue",
        agentDir: "/test/agent",
        authProfileId: "dialogue-profile",
      }),
    ).resolves.toMatchObject({ model, apiKey: "summary-key" });
    expect(resolveModel).toHaveBeenCalledWith(provider, "summary", "/test/agent", cfg);
    expect(getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        agentDir: "/test/agent",
        profileId: provider === "dialogue" ? "dialogue-profile" : undefined,
      }),
    );
  },
);

it("does not request credentials for an unresolved configured model", async () => {
  vi.mocked(resolveModel).mockReturnValue({ error: "missing" } as ReturnType<typeof resolveModel>);
  await expect(
    resolveCompactionModel({
      cfg: { agents: { defaults: { compaction: { model: "missing" } } } },
      provider: "dialogue",
    }),
  ).rejects.toThrow("compaction_model_unavailable");
  expect(getApiKeyForModel).not.toHaveBeenCalled();
});

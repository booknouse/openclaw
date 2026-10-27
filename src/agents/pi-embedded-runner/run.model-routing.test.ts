import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { FailoverError } from "../failover-error.js";
import { getApiKeyForModel } from "../model-auth.js";
import { runWithModelFallback } from "../model-fallback.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { mockedGlobalHookRunner } from "./run.overflow-compaction.mocks.shared.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";

vi.mock("../model-fallback.js", () => ({
  runWithModelFallback: vi.fn(async (params) => {
    try {
      return { result: await params.run(params.provider, params.model), attempts: [] };
    } catch (error) {
      if (!(error instanceof FailoverError)) {
        throw error;
      }
      const [provider, model] = params.fallbacksOverride[0].split("/");
      return { result: await params.run(provider, model), attempts: [] };
    }
  }),
}));
const config: OpenClawConfig = {
  agents: {
    defaults: {
      modelRouting: "cost",
      model: "ddww/sol",
      subagents: { model: "ddww/terra" },
    },
  },
};
const base = {
  ...overflowBaseRunParams,
  config,
  sessionKey: "agent:main:main",
  trigger: "user",
  provider: "ddww",
  model: "sol",
};

describe("embedded cost-routing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedRunEmbeddedAttempt.mockReset().mockResolvedValue(makeAttemptResult());
  });
  it("makes only one worker model attempt for a simple request", async () => {
    await runEmbeddedPiAgent({ ...base, prompt: "翻译成中文：Good morning." });
    expect(runWithModelFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ddww",
        model: "terra",
        fallbacksOverride: ["ddww/sol"],
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ddww",
        modelId: "terra",
        costRoutingRole: "direct",
        modelRoutingFallback: true,
      }),
    );
  });
  it("does not send primary-provider auth profiles to a different worker provider", async () => {
    const cfg = structuredClone(config);
    cfg.agents!.defaults!.subagents!.model = "worker-provider/terra";
    await runEmbeddedPiAgent({
      ...base,
      config: cfg,
      prompt: "翻译成中文：Good morning.",
      authProfileId: "primary-profile",
      authProfileIdSource: "auto",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "worker-provider",
        authProfileId: "test-profile",
        authProfileIdSource: "auto",
      }),
    );
    expect(getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: undefined }),
    );
    expect(getApiKeyForModel).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "primary-profile" }),
    );
  });
  it("keeps a complex request on the primary with the orchestration role", async () => {
    await runEmbeddedPiAgent({ ...base, prompt: "Investigate the incident and fix the code" });
    expect(runWithModelFallback).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ddww",
        modelId: "sol",
        costRoutingRole: "orchestrator",
      }),
    );
  });
  it("makes an equal-model configuration take the original single attempt", async () => {
    const cfg = structuredClone(config);
    cfg.agents!.defaults!.subagents!.model = "ddww/sol";
    await runEmbeddedPiAgent({ ...base, config: cfg, prompt: "翻译成中文：Good morning." });
    expect(runWithModelFallback).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].costRoutingRole).toBeUndefined();
  });
  it("does not override a plugin's model and tool-flow decision", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation((name) => name === "before_model_resolve");
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValue({
      modelOverride: "plugin-model",
    });
    await runEmbeddedPiAgent({ ...base, prompt: "Investigate the incident" });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "plugin-model", costRoutingRole: undefined }),
    );
  });
  it("falls back once to the primary after a worker provider failure", async () => {
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(
      new FailoverError("worker unavailable", { reason: "model_not_found" }),
    );
    await runEmbeddedPiAgent({ ...base, prompt: "翻译成中文：Good morning." });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      modelId: "sol",
      costRoutingRole: "direct",
    });
  });
  it("does not retry protected-context failures as a different model", async () => {
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("protected_context_too_large"));
    await expect(
      runEmbeddedPiAgent({ ...base, prompt: "翻译成中文：Good morning." }),
    ).rejects.toThrow("protected_context_too_large");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});

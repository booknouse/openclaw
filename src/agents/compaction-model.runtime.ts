import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { compactionModelPools } from "./compaction-model-config.js";
import { runCompactionModelCall } from "./compaction-model-limiter.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { getApiKeyForModel } from "./model-auth.js";
import { withAgentUserAgent } from "./model-user-agent.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

const log = createSubsystemLogger("compaction-model");

export type CompactionSummaryRunner = <T>(
  signal: AbortSignal,
  run: (model: Model<Api>, apiKey: string) => Promise<T>,
) => Promise<T>;

/** Resolve model metadata before sizing chunks; select the actual model for each request. */
export async function resolveCompactionModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  agentDir?: string;
  authProfileId?: string;
}) {
  const configured = compactionModelPools(params.cfg.agents?.defaults?.compaction);
  const models = configured.map((pool) => {
    if (!pool.model) {
      throw new Error("compaction_model_not_configured");
    }
    const slash = pool.model.indexOf("/");
    const provider = slash > 0 ? pool.model.slice(0, slash).trim() : params.provider;
    const modelId = slash > 0 ? pool.model.slice(slash + 1).trim() : pool.model;
    const { model } = resolveModel(provider, modelId, params.agentDir, params.cfg);
    if (!model) {
      throw new Error("compaction_model_unavailable");
    }
    return {
      model: withAgentUserAgent(model, params.agentId),
      key: `${model.provider}/${model.id}`,
      maxConcurrent: pool.maxConcurrent,
    };
  });
  if (new Set(models.map((pool) => pool.key)).size !== models.length) {
    throw new Error("compaction_model_duplicate_pools");
  }
  const getKey = async (model: Model<Api>) => {
    const auth = await getApiKeyForModel({
      model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileId: model.provider === params.provider ? params.authProfileId : undefined,
    });
    if (!auth.apiKey) {
      throw new Error("compaction_model_auth_unavailable");
    }
    return auth.apiKey;
  };
  const model = models[0].model;
  const apiKey = await getKey(model);
  const runSummary: CompactionSummaryRunner = (signal, run) =>
    runCompactionModelCall({
      signal,
      pools: models,
      run: async (key) => {
        const selected = models.find((pool) => pool.key === key)!.model;
        const selectedKey = selected === model ? apiKey : await getKey(selected);
        signal.throwIfAborted();
        const startedAt = Date.now();
        log.debug(`summary request start model=${key}`);
        try {
          return await run(selected, selectedKey);
        } finally {
          log.debug(`summary request end model=${key} durationMs=${Date.now() - startedAt}`);
        }
      },
    });
  return {
    model,
    apiKey,
    contextWindow: Math.min(
      ...models.map((pool) => pool.model.contextWindow || DEFAULT_CONTEXT_TOKENS),
    ),
    runSummary,
  };
}

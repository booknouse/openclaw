import type { AgentCompactionConfig } from "../config/types.agent-defaults.js";

export const PRIMARY_COMPACTION_CONCURRENCY = 4;
export const SECONDARY_COMPACTION_CONCURRENCY = 10;

export function compactionModelReference(config?: AgentCompactionConfig): string | undefined {
  return config?.models?.primary.model.trim() || config?.model?.trim() || undefined;
}

export function compactionModelPools(config?: AgentCompactionConfig) {
  const primary = {
    model: compactionModelReference(config),
    maxConcurrent:
      config?.models?.primary.maxConcurrent ??
      (config?.models
        ? PRIMARY_COMPACTION_CONCURRENCY
        : (config?.background?.maxConcurrent ?? PRIMARY_COMPACTION_CONCURRENCY)),
  };
  const secondary = config?.models?.secondary;
  return secondary
    ? [
        primary,
        {
          model: secondary.model.trim(),
          maxConcurrent: secondary.maxConcurrent ?? SECONDARY_COMPACTION_CONCURRENCY,
        },
      ]
    : [primary];
}

export function compactionBackgroundConcurrency(config?: AgentCompactionConfig): number {
  return compactionModelPools(config).reduce((total, pool) => total + pool.maxConcurrent, 0);
}

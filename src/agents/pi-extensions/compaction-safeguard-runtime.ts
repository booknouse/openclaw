import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import type { CompactionSummaryRunner } from "../compaction-model.runtime.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type CompactionSafeguardRuntimeValue = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  failure?: { code: string; message: string };
  /** Share the bounded concise generator with background compaction. */
  conciseSummary?: boolean;
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
  customInstructions?: string;
  /**
   * Model to use for compaction summarization.
   * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
   * (extensionRunner.initialize() is never called in that path).
   */
  model?: Model<Api>;
  resolveModel?: () => Promise<{
    model: Model<Api>;
    apiKey: string;
    contextWindow?: number;
    runSummary?: CompactionSummaryRunner;
  }>;
  modelConcurrency?: number;
  recentTurnsPreserve?: number;
  qualityGuardEnabled?: boolean;
  qualityGuardMaxRetries?: number;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;

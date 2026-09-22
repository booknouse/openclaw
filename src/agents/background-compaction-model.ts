import type { BackgroundCompactionPreparation } from "./background-compaction-state.js";
import type { BackgroundCompactionParams } from "./background-compaction.js";
import { generateCompactionSummary } from "./compaction-summary.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

export async function summarizeBackgroundContext(
  params: BackgroundCompactionParams & {
    preparation: BackgroundCompactionPreparation;
    signal: AbortSignal;
    onModelSelected?: (model: string) => void;
  },
): Promise<string> {
  const cfg = params.config!.agents!.defaults!.compaction!;
  await ensureOpenClawModelsJson(params.config, params.agentDir);
  const { resolveCompactionModel } = await import("./compaction-model.runtime.js");
  const { runSummary } = await resolveCompactionModel({
    cfg: params.config!,
    provider: params.provider,
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
  });
  return runSummary(params.signal, (model, apiKey) => {
    params.onModelSelected?.(`${model.provider}/${model.id}`);
    return generateCompactionSummary({
      messages: params.preparation.messagesToSummarize,
      model,
      apiKey,
      signal: params.signal,
      maxOutputTokens: cfg.background?.maxOutputTokens ?? 4096,
      customInstructions: cfg.customInstructions,
      sessionId: params.sessionId,
    });
  });
}

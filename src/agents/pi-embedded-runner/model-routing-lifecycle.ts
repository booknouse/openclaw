import { emitAgentEvent } from "../../infra/agent-events.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiRunResult } from "./types.js";

/** A rejected worker must not detach webchat before the primary has been tried. */
export async function runWithModelRoutingLifecycle(
  params: RunEmbeddedPiAgentParams,
  run: (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>,
): Promise<EmbeddedPiRunResult> {
  let pending = false;
  let terminal = false;
  const onAgentEvent: NonNullable<RunEmbeddedPiAgentParams["onAgentEvent"]> = (event) => {
    if (event.stream === "lifecycle") {
      if (event.data.phase === "model_fallback") {
        pending = true;
      } else if (event.data.phase === "end" || event.data.phase === "error") {
        terminal = true;
      }
    }
    params.onAgentEvent?.(event);
  };
  const finish = (error?: string) => {
    if (!pending || terminal) {
      return;
    }
    terminal = true;
    const data = error
      ? { phase: "error", errorCode: "model_routing_failed", error, endedAt: Date.now() }
      : { phase: "end", endedAt: Date.now() };
    emitAgentEvent({ runId: params.runId, stream: "lifecycle", data });
    params.onAgentEvent?.({ stream: "lifecycle", data });
  };
  try {
    const result = await run({ ...params, onAgentEvent, modelRoutingFallback: true });
    finish(result.meta.error?.message ?? (result.meta.aborted ? "Run aborted." : undefined));
    return result;
  } catch (error) {
    finish(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

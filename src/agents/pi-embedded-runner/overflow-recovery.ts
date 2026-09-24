import { emitAgentEvent } from "../../infra/agent-events.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiRunResult } from "./types.js";

/** Attempt-level overflows are nonterminal until the runner has finished recovery. */
export async function runWithOverflowRecovery(
  params: RunEmbeddedPiAgentParams,
  run: (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>,
): Promise<EmbeddedPiRunResult> {
  let recovering = false;
  let terminal = false;
  let failure: { code: string; message: string } | undefined;
  const onAgentEvent: NonNullable<RunEmbeddedPiAgentParams["onAgentEvent"]> = (event) => {
    if (event.stream === "lifecycle") {
      if (event.data.phase === "recovering") {
        recovering = true;
        terminal = false;
        failure = undefined;
      } else if (event.data.phase === "end" || event.data.phase === "error") {
        terminal = true;
      }
    }
    if (recovering && event.stream === "compaction" && event.data.phase === "end") {
      if (event.data.outcome === "failed" || event.data.outcome === "cancelled") {
        failure = {
          code:
            typeof event.data.errorCode === "string"
              ? event.data.errorCode
              : event.data.outcome === "cancelled"
                ? "context_recovery_aborted"
                : "compaction_failed",
          message:
            typeof event.data.error === "string"
              ? event.data.error
              : "Context compaction did not complete; history preserved.",
        };
      } else {
        failure = undefined;
      }
    }
    params.onAgentEvent?.(event);
  };
  const finish = (error?: { code: string; message: string }) => {
    if (!recovering || terminal) {
      return;
    }
    terminal = true;
    const data = error
      ? {
          phase: "error",
          errorCode: error.code,
          error: `${error.code}: ${error.message}`,
          endedAt: Date.now(),
        }
      : { phase: "end", endedAt: Date.now() };
    emitAgentEvent({ runId: params.runId, stream: "lifecycle", data });
    params.onAgentEvent?.({ stream: "lifecycle", data });
  };
  try {
    let result = await run({ ...params, onAgentEvent });
    if (recovering && !terminal) {
      if (failure) {
        // The SDK removes the overflowing assistant from its in-memory history before
        // compacting. A cancelled summary must not expose an older successful reply.
        result = {
          ...result,
          payloads: [{ text: failure.message, isError: true }],
          meta: { ...result.meta, error: { kind: "compaction_failure", message: failure.message } },
        };
      }
      finish(
        failure ??
          (result.meta.error
            ? { code: result.meta.error.kind, message: result.meta.error.message }
            : result.meta.aborted
              ? { code: "context_recovery_aborted", message: "Context recovery was aborted." }
              : undefined),
      );
    }
    return result;
  } catch (error) {
    finish(
      failure ?? {
        code: "context_recovery_failed",
        message: "Context recovery failed; history preserved.",
      },
    );
    throw error;
  }
}

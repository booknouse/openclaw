import fs from "node:fs";
import {
  buildSessionContext,
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import {
  getBackgroundCompactionJob,
  getBackgroundCompactionStatus,
} from "../../agents/background-compaction-state.js";
import {
  backgroundCompactionEnabled,
  backgroundSnapshotMatches,
  estimateBackgroundContextTokens,
} from "../../agents/background-compaction.js";
import { compactionModelReference } from "../../agents/compaction-model-config.js";
import { getCompactionStatus } from "../../agents/compaction-status.js";
import { getNativeCompactionFailure } from "../../agents/native-compaction-state.js";
import { isEmbeddedPiRunActive } from "../../agents/pi-embedded.js";
import {
  TRANSCRIPT_ROTATE_BYTES,
  TRANSCRIPT_HARD_BYTES,
} from "../../agents/session-transcript-budget.js";
import { stripToolResultDetails } from "../../agents/session-transcript-repair.js";
import { countActiveDescendantRuns } from "../../agents/subagent-registry.js";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { readBoundedSessionContext } from "../session-bounded-context.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "../session-utils.js";
import { cachedContext, cacheContext, contextFileSignature } from "./session-context-cache.js";
import type { GatewayRequestHandler } from "./types.js";

/** A single-session lookup; callers need not transfer the entire global status/index. */
export const sessionsContext: GatewayRequestHandler = async ({ params, respond }) => {
  if (
    typeof params.key !== "string" ||
    !params.key.trim() ||
    Object.keys(params).some((key) => !["key", "handoff"].includes(key)) ||
    (params.handoff !== undefined && typeof params.handoff !== "boolean")
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "expected key and optional handoff"),
    );
    return;
  }
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.key });
  const store = loadSessionStore(target.storePath);
  const entry = target.storeKeys.map((key) => store[key]).find(Boolean);
  const enabled = backgroundCompactionEnabled(cfg);
  const engine = cfg.plugins?.slots?.contextEngine;
  const mode = enabled
    ? "background"
    : compactionModelReference(cfg.agents?.defaults?.compaction) && (!engine || engine === "legacy")
      ? "on-demand"
      : "disabled";
  if (!entry?.sessionId) {
    respond(
      true,
      { exists: false, backgroundCompaction: { enabled, mode, state: "idle" } },
      undefined,
    );
    return;
  }
  const file = resolveSessionTranscriptCandidates(
    entry.sessionId,
    target.storePath,
    entry.sessionFile,
    target.agentId,
  ).find((path) => fs.existsSync(path));
  const budget = entry.contextTokens ?? cfg.agents?.defaults?.contextTokens;
  const reserve = cfg.agents?.defaults?.compaction?.background?.reserveTokens ?? 20_000;
  const running =
    isEmbeddedPiRunActive(entry.sessionId) || getCompactionStatus(entry.sessionId).blocking;
  if (!file) {
    respond(
      true,
      {
        exists: true,
        sessionId: entry.sessionId,
        running,
        usedTokens: 0,
        contextTokens: budget,
        compaction: getCompactionStatus(entry.sessionId),
        contextCapabilities: { statusVersion: 1, rejectIfCompacting: true },
        observedAt: new Date().toISOString(),
        source: "context_estimate",
        backgroundCompaction: { enabled, mode, state: "idle" },
      },
      undefined,
    );
    return;
  }
  const jobBeforeRead = getBackgroundCompactionJob(file);
  const transcriptBytes = fs.statSync(file).size;
  const fileSignature = contextFileSignature(file, entry.sessionId);
  const signature = `${fileSignature}:${mode}:${budget}:${jobBeforeRead?.state ?? "idle"}`;
  const reply = (body: Record<string, unknown>) => {
    const compaction = getCompactionStatus(entry.sessionId);
    const previous = body.backgroundCompaction as Record<string, unknown>;
    const failure = mode === "on-demand" ? getNativeCompactionFailure(file) : undefined;
    const failed =
      failure &&
      (!previous.lastCompactionAt ||
        Date.parse(typeof previous.lastCompactionAt === "string" ? previous.lastCompactionAt : "") <
          failure.failedAt);
    respond(
      true,
      {
        ...body,
        running,
        contextTokens: budget,
        compaction,
        contextCapabilities: { statusVersion: 1, rejectIfCompacting: true },
        runtimeSafety: {
          version: 1,
          transcriptBytes,
          rotateAtBytes: TRANSCRIPT_ROTATE_BYTES,
          hardLimitBytes: TRANSCRIPT_HARD_BYTES,
          rotationRequired: transcriptBytes >= TRANSCRIPT_ROTATE_BYTES,
          canRotate:
            !running &&
            countActiveDescendantRuns(target.canonicalKey ?? (params.key as string)) === 0,
        },
        backgroundCompaction: {
          ...previous,
          ...(mode === "on-demand"
            ? { state: compaction.blocking ? "running" : failed ? "failed" : "idle" }
            : {}),
        },
      },
      undefined,
    );
  };
  const cached =
    params.handoff !== true && jobBeforeRead?.state !== "ready"
      ? cachedContext(file, signature)
      : undefined;
  if (cached) {
    reply(cached);
    return;
  }
  const snapshot = await readBoundedSessionContext(
    file,
    entry.sessionId,
    jobBeforeRead?.state === "ready",
  );
  const entries = snapshot.entries;
  const messages = snapshot.messages;
  const used = snapshot.complete ? estimateBackgroundContextTokens(messages) : undefined;
  const job = getBackgroundCompactionJob(file);
  const ready =
    enabled &&
    snapshot.ancestorsComplete &&
    job?.state === "ready" &&
    backgroundSnapshotMatches(job, entries);
  let effectiveMessages = messages;
  if (ready && job.summary) {
    effectiveMessages = buildSessionContext([
      ...entries,
      {
        type: "compaction",
        id: "background-preview",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary: job.summary + (job.protectedContext ?? ""),
        firstKeptEntryId: job.preparation.firstKeptEntryId,
        tokensBefore: job.preparation.tokensBefore,
      },
    ]).messages;
  }
  const textEstimate = messages.reduce((n, m) => n + estimateTokens(m), 0);
  const effective = ready
    ? Math.ceil(effectiveMessages.reduce((n, m) => n + estimateTokens(m), 0) * 1.2) +
      Math.max(0, (used ?? 0) - textEstimate)
    : used;
  const last = entries.findLast((item) => item.type === "compaction");
  const observedFailure = mode === "on-demand" ? getNativeCompactionFailure(file) : undefined;
  const nativeFailure =
    observedFailure && (!last || Date.parse(last.timestamp) < observedFailure.failedAt)
      ? observedFailure
      : undefined;
  const committedText =
    params.handoff === true && snapshot.complete
      ? serializeConversation(convertToLlm(stripToolResultDetails(messages)))
      : undefined;
  const handoff =
    params.handoff === true && snapshot.complete
      ? ready
        ? serializeConversation(convertToLlm(stripToolResultDetails(effectiveMessages)))
        : committedText
      : undefined;
  const handoffFits =
    snapshot.complete &&
    handoff !== undefined &&
    Buffer.byteLength(handoff, "utf8") <= 2 * 1024 * 1024;
  const payload = {
    observedAt: new Date().toISOString(),
    source: "context_estimate",
    exists: true,
    sessionId: entry.sessionId,
    running,
    usedTokens: used,
    contextTokens: budget,
    compactionCount:
      entry.compactionCount ?? entries.filter((item) => item.type === "compaction").length,
    contextRead: { complete: snapshot.complete, reason: snapshot.reason },
    backgroundCompaction: {
      enabled,
      mode,
      ...(enabled ? getBackgroundCompactionStatus(file) : {}),
      state:
        mode === "on-demand"
          ? nativeFailure
            ? "failed"
            : "idle"
          : ready
            ? "ready"
            : job?.state === "ready"
              ? "idle"
              : getBackgroundCompactionStatus(file).state,
      ...(nativeFailure
        ? { reason: "native_compaction_failed", failedAt: nativeFailure.failedAt }
        : {}),
      effectiveUsedTokens: effective,
      reserveTokens: reserve,
      lastCompactionAt: last?.timestamp,
      lastCompactionId: last?.id,
      checkpointVersion: 1,
    },
    ...(params.handoff === true
      ? {
          handoff: {
            text: handoffFits ? handoff : "",
            complete: handoffFits,
          },
        }
      : {}),
    // A recovery checkpoint always reflects committed history, never a ready preview.
    ...(params.handoff === true &&
    !running &&
    snapshot.complete &&
    committedText !== undefined &&
    Buffer.byteLength(committedText, "utf8") <= 2 * 1024 * 1024
      ? {
          checkpoint: {
            version: 1,
            sessionId: entry.sessionId,
            compactionId: last?.id ?? null,
            compactionTimestamp: last?.timestamp ?? null,
            firstKeptEntryId: last?.firstKeptEntryId ?? null,
            tailEntryId: entries.at(-1)?.id ?? null,
            text: committedText,
            complete: true,
          },
        }
      : {}),
  };
  if (
    params.handoff !== true &&
    snapshot.complete &&
    jobBeforeRead?.state !== "ready" &&
    contextFileSignature(file, entry.sessionId) === fileSignature
  ) {
    cacheContext(file, signature, payload);
  }
  reply(payload);
};

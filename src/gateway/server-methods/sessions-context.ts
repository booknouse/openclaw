import fs from "node:fs";
import {
  buildSessionContext,
  convertToLlm,
  estimateTokens,
  serializeConversation,
  SessionManager,
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
import { isEmbeddedPiRunActive } from "../../agents/pi-embedded.js";
import { stripToolResultDetails } from "../../agents/session-transcript-repair.js";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "../session-utils.js";
import type { GatewayRequestHandler } from "./types.js";

/** A single-session lookup; callers need not transfer the entire global status/index. */
export const sessionsContext: GatewayRequestHandler = ({ params, respond }) => {
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
  if (!entry?.sessionId) {
    respond(true, { exists: false, backgroundCompaction: { enabled, state: "idle" } }, undefined);
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
  const running = isEmbeddedPiRunActive(entry.sessionId);
  if (!file) {
    respond(
      true,
      {
        exists: true,
        sessionId: entry.sessionId,
        running,
        backgroundCompaction: { enabled, state: "idle" },
      },
      undefined,
    );
    return;
  }
  const manager = SessionManager.open(file);
  const entries = manager.getBranch();
  const messages = manager.buildSessionContext().messages;
  const used = estimateBackgroundContextTokens(messages);
  const job = getBackgroundCompactionJob(file);
  const ready = enabled && job?.state === "ready" && backgroundSnapshotMatches(job, entries);
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
      Math.max(0, used - textEstimate)
    : used;
  const last = entries.findLast((item) => item.type === "compaction");
  const handoff =
    params.handoff === true
      ? serializeConversation(convertToLlm(stripToolResultDetails(effectiveMessages)))
      : undefined;
  respond(
    true,
    {
      exists: true,
      sessionId: entry.sessionId,
      running,
      usedTokens: used,
      contextTokens: budget,
      compactionCount: entries.filter((item) => item.type === "compaction").length,
      backgroundCompaction: {
        enabled,
        ...getBackgroundCompactionStatus(file),
        state: ready
          ? "ready"
          : job?.state === "ready"
            ? "idle"
            : getBackgroundCompactionStatus(file).state,
        effectiveUsedTokens: effective,
        reserveTokens: reserve,
        lastCompactionAt: last?.timestamp,
      },
      ...(handoff !== undefined ? { handoff: { text: handoff, complete: true } } : {}),
    },
    undefined,
  );
};

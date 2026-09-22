import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  buildSessionContext,
  estimateTokens,
  findCutPoint,
  type SessionEntry,
  type SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  cancelBackgroundCompaction,
  claimBackgroundCompaction,
  getBackgroundCompactionJob,
  releaseBackgroundCompactionSlot,
  type BackgroundCompactionJob,
  type BackgroundCompactionPreparation,
} from "./background-compaction-state.js";
import {
  compactionBackgroundConcurrency,
  compactionModelReference,
} from "./compaction-model-config.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

const log = createSubsystemLogger("background-compaction");
type Manager = Pick<SessionManager, "getBranch" | "buildSessionContext" | "appendCompaction">;
export type BackgroundCompactionParams = {
  config?: OpenClawConfig;
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  sessionManager: Manager;
  tokenBudget: number;
  agentDir: string;
  provider: string;
  authProfileId?: string;
};

export function backgroundCompactionEnabled(config?: OpenClawConfig): boolean {
  const slot = config?.plugins?.slots?.contextEngine;
  return (
    config?.agents?.defaults?.compaction?.background?.enabled === true &&
    (!slot || slot === "legacy")
  );
}

function fingerprint(entries: SessionEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function estimateBackgroundContextTokens(messages: AgentMessage[]): number {
  let estimate = 0;
  let contentEstimate = 0;
  for (const message of stripToolResultDetails(messages)) {
    contentEstimate += estimateTokens(message);
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.usage
    ) {
      const usage = message.usage;
      const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      estimate = tokens > 0 ? tokens : estimate + estimateTokens(message);
    } else {
      estimate += estimateTokens(message);
    }
  }
  return Math.max(estimate, contentEstimate);
}

export function prepareBackgroundCompaction(
  entries: SessionEntry[],
  keepRecentTokens: number,
  tokensBefore: number,
): BackgroundCompactionPreparation | undefined {
  const previousIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const cut = findCutPoint(entries, previousIndex + 1, entries.length, keepRecentTokens);
  let firstKeptIndex = cut.firstKeptEntryIndex;
  if (firstKeptIndex <= previousIndex + 1) {
    // An oversized trailing tool result has no valid cut *after* it. Pi then
    // keeps everything; retain the whole latest user turn and compact older turns.
    firstKeptIndex = entries.findLastIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
  }
  const kept = entries[firstKeptIndex];
  if (!kept || firstKeptIndex <= previousIndex + 1) {
    return undefined;
  }
  // Resolve prior compaction + its retained turns before taking the new prefix.
  // Pi chooses a cut at user/assistant boundaries, never inside tool results.
  const prefix = entries.slice(0, firstKeptIndex);
  const messages = buildSessionContext(prefix, prefix.at(-1)?.id).messages;
  const previous = entries[previousIndex];
  return {
    firstKeptEntryId: kept.id,
    messagesToSummarize: messages,
    tokensBefore,
    previousSummary: previous?.type === "compaction" ? previous.summary : undefined,
  };
}

export function backgroundSnapshotMatches(
  job: BackgroundCompactionJob,
  entries: SessionEntry[],
): boolean {
  return (
    entries.length >= job.snapshotIds.length &&
    job.snapshotIds.every((id, i) => entries[i]?.id === id) &&
    fingerprint(entries.slice(0, job.snapshotIds.length)) === job.snapshotHash &&
    // A foreground/native compaction always wins over an older background job.
    !entries.slice(job.snapshotIds.length).some((entry) => entry.type === "compaction")
  );
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    : "";
}

/** Keep explicit user constraints verbatim and precise identifiers without accumulating prose. */
export function collectProtectedContext(messages: AgentMessage[], previous?: string): string {
  const constraints = new Set<string>();
  const identifiers = new Set<string>();
  const marker = "\n<protected-context>\n";
  const constraintPattern = /不得|禁止|不要|必须|严禁|只读|do not|must|never/i;
  const identifierPattern =
    /(?:\/[\w.@-]+){2,}|\b[\w.-]+\.(?:py|ps1|sh|sql|ts)\b|\b(?:[a-f\d]{12,40}|[A-Z][A-Z\d_]+-\d[\w-]*)\b/g;
  const collect = (line: string, preserveConstraint: boolean) => {
    const value = line.trim();
    if (!value) {
      return;
    }
    if (preserveConstraint && constraintPattern.test(value)) {
      constraints.add(value);
    }
    for (const match of value.matchAll(identifierPattern)) {
      identifiers.add(match[0]);
    }
  };
  // Upgrade old protected blocks in place: retain constraints, deduplicate identifier tokens.
  const old = previous?.split(marker)[1]?.split("\n</protected-context>")[0];
  for (const line of old?.split("\n") ?? []) {
    collect(line, true);
  }
  for (const message of stripToolResultDetails(messages)) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    for (const line of messageText(message).split("\n")) {
      collect(line, message.role === "user");
    }
  }
  // Keep one textual representation: constraints already contain some identifiers,
  // and a full path also preserves its parent directories and basename verbatim.
  // Do not collapse opaque identifiers merely because one is a substring of another.
  const represented = new Set<string>();
  for (const line of constraints) {
    for (const id of line.matchAll(
      /(?:\/[\w.@-]+){2,}|\b[\w.-]+\.(?:py|ps1|sh|sql|ts)\b|\b(?:[a-f\d]{12,40}|[A-Z][A-Z\d_]+-\d[\w-]*)\b/g,
    )) {
      represented.add(id[0]);
    }
  }
  for (const id of identifiers) {
    if (!id.startsWith("/")) {
      continue;
    }
    const segments = id.split("/");
    for (let i = 3; i < segments.length; i++) {
      represented.add(segments.slice(0, i).join("/"));
    }
    const basename = segments.at(-1)!;
    if (/\.(?:py|ps1|sh|sql|ts)$/.test(basename)) {
      represented.add(basename);
    }
  }
  const result = [...constraints, ...[...identifiers].filter((id) => !represented.has(id))].join(
    "\n",
  );
  // True oversized constraints still fail safely; never clip user instructions to fit.
  if (result.length > 24_000) {
    throw new Error("protected_context_too_large");
  }
  return result ? `${marker}${result}\n</protected-context>` : "";
}

/** Called under the normal session write lock, before constructing the Pi session. */
export function commitReadyBackgroundCompaction(params: BackgroundCompactionParams): boolean {
  const job = getBackgroundCompactionJob(params.sessionFile);
  if (!job || job.state !== "ready") {
    return false;
  }
  const entries = params.sessionManager.getBranch();
  if (
    !backgroundCompactionEnabled(params.config) ||
    job.sessionId !== params.sessionId ||
    !backgroundSnapshotMatches(job, entries)
  ) {
    cancelBackgroundCompaction(params.sessionFile);
    return false;
  }
  const summary = job.summary! + (job.protectedContext ?? "");
  params.sessionManager.appendCompaction(
    summary,
    job.preparation.firstKeptEntryId,
    job.preparation.tokensBefore,
    {
      background: true,
      model: job.model ?? compactionModelReference(params.config?.agents?.defaults?.compaction),
    },
    true,
  );
  cancelBackgroundCompaction(params.sessionFile);
  emitSessionTranscriptUpdate(params.sessionFile);
  const contentTokens = stripToolResultDetails(
    params.sessionManager.buildSessionContext().messages,
  ).reduce((sum, message) => sum + estimateTokens(message), 0);
  log.info(
    `committed session=${params.sessionId} concurrentEntries=${entries.length - job.snapshotIds.length} effectiveContentTokens=${contentTokens} summaryChars=${summary.length}`,
  );
  return true;
}

/** Schedule one bounded provider request; never hold a session lock while awaiting the model. */
export function scheduleBackgroundCompaction(params: BackgroundCompactionParams): boolean {
  if (!backgroundCompactionEnabled(params.config)) {
    return false;
  }
  const cfg = params.config!.agents!.defaults!.compaction!;
  const options = cfg.background!;
  const existing = getBackgroundCompactionJob(params.sessionFile);
  if (
    existing &&
    (existing.state === "running" ||
      existing.state === "ready" ||
      (existing.retryAfter ?? 0) > Date.now())
  ) {
    return false;
  }
  const messages = params.sessionManager.buildSessionContext().messages;
  const used = estimateBackgroundContextTokens(messages);
  if (used < params.tokenBudget * (options.triggerRatio ?? 0.7)) {
    return false;
  }
  const entries = params.sessionManager.getBranch();
  const preparation = prepareBackgroundCompaction(entries, cfg.keepRecentTokens ?? 8_000, used);
  if (!preparation?.messagesToSummarize.length) {
    return false;
  }
  const job: BackgroundCompactionJob = {
    state: "running",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    touchedAt: Date.now(),
    startedAt: Date.now(),
    controller: new AbortController(),
    snapshotIds: entries.map((entry) => entry.id),
    snapshotHash: fingerprint(entries),
    preparation: structuredClone(preparation),
  };
  if (!claimBackgroundCompaction(params.sessionFile, job, compactionBackgroundConcurrency(cfg))) {
    return false;
  }
  log.info(
    `scheduled session=${params.sessionId} usedTokens=${used} sourceMessages=${preparation.messagesToSummarize.length}`,
  );
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Limit lifetime independently of whether the provider honors AbortSignal.
  job.timer = setTimeout(() => job.controller.abort(), timeoutMs);
  job.timer.unref?.();
  void Promise.resolve().then(async () => {
    try {
      const source = preparation.messagesToSummarize;
      job.protectedContext = collectProtectedContext(source, preparation.previousSummary);
      const { summarizeBackgroundContext } = await import("./background-compaction-model.js");
      const summary = await Promise.race([
        summarizeBackgroundContext({
          ...params,
          preparation: job.preparation,
          signal: job.controller.signal,
          onModelSelected: (model) => {
            job.model = model;
          },
        }),
        new Promise<never>((_, reject) => {
          if (job.controller.signal.aborted) {
            reject(new Error("background_compaction_timeout"));
          } else {
            job.controller.signal.addEventListener(
              "abort",
              () => reject(new Error("background_compaction_timeout")),
              { once: true },
            );
          }
        }),
      ]);
      if (getBackgroundCompactionJob(params.sessionFile) !== job) {
        return;
      }
      const summaryTokens = estimateTokens({
        role: "user",
        content: summary + job.protectedContext,
        timestamp: 0,
      });
      const removedTokens = source.reduce((sum, m) => sum + estimateTokens(m), 0);
      if (!summary.trim() || summaryTokens >= removedTokens) {
        throw new Error("summary_did_not_reduce_context");
      }
      job.summary = summary;
      job.state = "ready";
      job.finishedAt = Date.now();
      log.info(`ready session=${params.sessionId} durationMs=${job.finishedAt - job.startedAt!}`);
    } catch (error) {
      if (getBackgroundCompactionJob(params.sessionFile) !== job) {
        return;
      }
      job.state = "failed";
      job.reason = job.controller.signal.aborted ? "timeout" : "summary_failed";
      job.finishedAt = Date.now();
      job.retryAfter = Date.now() + (options.retryDelayMs ?? 60_000);
      // Provider errors can contain credentials; log only a classification.
      const knownFailures = new Set([
        "protected_context_too_large",
        "summary_did_not_reduce_context",
        "background_compaction_incomplete",
        "background_compaction_invalid_format",
      ]);
      const detail =
        error instanceof Error && knownFailures.has(error.message)
          ? error.message
          : "provider_or_internal_error";
      log.warn(`failed session=${params.sessionId} reason=${job.reason} detail=${detail}`);
    } finally {
      if (job.timer) {
        clearTimeout(job.timer);
      }
      releaseBackgroundCompactionSlot();
    }
  });
  return true;
}

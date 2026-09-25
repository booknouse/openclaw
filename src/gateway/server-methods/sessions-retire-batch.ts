import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { cancelBackgroundCompactionForSession } from "../../agents/background-compaction-state.js";
import { resolveSessionLane } from "../../agents/pi-embedded-runner/lanes.js";
import { isEmbeddedPiRunActive } from "../../agents/pi-embedded.js";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { countActiveDescendantRuns } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { getQueueSize } from "../../process/command-queue.js";
import {
  resolvePermanentArchiveDirectory,
  preparePermanentSessionArchive,
  removeArchivedOriginals,
  type PermanentSessionArchive,
} from "../session-archive.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "../session-utils.js";

export const MAX_RETIRE_BATCH_SIZE = 20;
export type RetirementResult = {
  key: string;
  deleted: boolean;
  reason?: string;
  archived?: string[];
  archiveDirectory?: string;
  originalCleanupFailed?: boolean;
};
type Target = ReturnType<typeof resolveGatewaySessionStoreTarget>;
type Candidate = {
  key: string;
  target: Target;
  entry: SessionEntry;
  paths: string[];
  archive?: PermanentSessionArchive;
  lock: Awaited<ReturnType<typeof acquireSessionWriteLock>>;
};

// Avoid overlapping sweeps from multiple Server workers in the same gateway.
let retiring = false;

function busy(key: string, target: Target, entry: SessionEntry): boolean {
  return (
    Boolean(entry.acp) ||
    isEmbeddedPiRunActive(entry.sessionId) ||
    countActiveDescendantRuns(target.canonicalKey) > 0 ||
    [key, target.canonicalKey, entry.sessionId].some(
      (id) => getQueueSize(resolveSessionLane(id)) > 0,
    )
  );
}

function entryFor(store: Record<string, SessionEntry>, target: Target) {
  return target.storeKeys.map((key) => store[key]).find(Boolean);
}

/** Bounded idle-only retirement: one write per backing index, no pruning or disk sweep. */
export async function retireIdleSessions(
  cfg: OpenClawConfig,
  keys: string[],
): Promise<RetirementResult[]> {
  if (!keys.length || keys.length > MAX_RETIRE_BATCH_SIZE) {
    throw new Error("invalid_retirement_batch_size");
  }
  const unique = [...new Set(keys)];
  if (retiring) {
    return unique.map((key) => ({ key, deleted: false, reason: "cleanup_busy" }));
  }
  retiring = true;
  try {
    const results = new Map<string, RetirementResult>();
    const stores = new Map<string, Record<string, SessionEntry>>();
    const groups = new Map<string, { key: string; target: Target }[]>();
    for (const key of unique) {
      const target = resolveGatewaySessionStoreTarget({ cfg, key, storeCache: stores });
      if (target.canonicalKey === resolveMainSessionKey(cfg)) {
        results.set(key, { key, deleted: false, reason: "main_session" });
        continue;
      }
      const group = groups.get(target.storePath) ?? [];
      group.push({ key, target });
      groups.set(target.storePath, group);
    }
    let archiveRoot: string;
    try {
      archiveRoot = await resolvePermanentArchiveDirectory(cfg, [...stores.keys()]);
    } catch {
      return unique.map(
        (key) => results.get(key) ?? { key, deleted: false, reason: "archive_unavailable" },
      );
    }
    for (const [storePath, group] of groups) {
      // Yield between indexes too; do not hold any store or transcript lock here.
      await delay(0);
      const snapshot = stores.get(storePath)!;
      const candidates: Candidate[] = [];
      const heldIds = new Set<string>();
      try {
        for (const { key, target } of group) {
          const entry = entryFor(snapshot, target);
          if (!entry?.sessionId) {
            results.set(key, { key, deleted: false });
            continue;
          }
          if (busy(key, target, entry) || heldIds.has(entry.sessionId)) {
            results.set(key, { key, deleted: false, reason: "busy_or_duplicate" });
            continue;
          }
          const paths = resolveSessionTranscriptCandidates(
            entry.sessionId,
            storePath,
            entry.sessionFile,
            target.agentId,
          );
          let file = paths[0];
          for (const path of paths) {
            if (
              await fs.stat(path).then(
                () => true,
                () => false,
              )
            ) {
              file = path;
              break;
            }
          }
          if (!file) {
            results.set(key, { key, deleted: false, reason: "unresolved_transcript" });
            continue;
          }
          try {
            const lock = await acquireSessionWriteLock({
              sessionFile: file,
              timeoutMs: 50,
              allowReentrant: false,
            });
            candidates.push({ key, target, entry, paths, lock });
            heldIds.add(entry.sessionId);
          } catch {
            results.set(key, { key, deleted: false, reason: "busy" });
          }
        }
        if (!candidates.length) {
          continue;
        }
        // Do file I/O before acquiring the shared index lock; failures keep the original intact.
        for (const candidate of candidates) {
          try {
            candidate.archive = await preparePermanentSessionArchive({
              root: archiveRoot,
              key: candidate.key,
              sessionId: candidate.entry.sessionId,
              agentId: candidate.target.agentId,
              storePath,
              paths: candidate.paths,
              entry: candidate.entry,
            });
          } catch {
            results.set(candidate.key, {
              key: candidate.key,
              deleted: false,
              reason: "archive_failed",
            });
          }
        }
        if (!candidates.some((candidate) => candidate.archive)) {
          continue;
        }
        await updateSessionStore(
          storePath,
          (store) => {
            // Build reverse references once, instead of scanning the index for every candidate.
            const references = new Map<string, string[]>();
            for (const [key, entry] of Object.entries(store)) {
              const refs = references.get(entry.sessionId) ?? [];
              refs.push(key);
              references.set(entry.sessionId, refs);
            }
            for (const candidate of candidates) {
              if (!candidate.archive) {
                continue;
              }
              const { key, target, entry } = candidate;
              const current = entryFor(store, target);
              const aliases = references.get(entry.sessionId) ?? [];
              if (
                !current ||
                current.sessionId !== entry.sessionId ||
                current.updatedAt !== entry.updatedAt ||
                current.sessionFile !== entry.sessionFile ||
                JSON.stringify(current.metadataRefs) !== JSON.stringify(entry.metadataRefs) ||
                busy(key, target, current) ||
                aliases.some((alias) => !target.storeKeys.includes(alias)) ||
                target.storeKeys.some(
                  (alias) => store[alias] && store[alias].sessionId !== entry.sessionId,
                )
              ) {
                results.set(key, { key, deleted: false, reason: "busy_or_changed" });
                continue;
              }
              // No await between the final idle check and index removal.
              for (const alias of aliases) {
                delete store[alias];
              }
              results.set(key, { key, deleted: true });
            }
          },
          { skipMaintenance: true },
        );
        for (const candidate of candidates) {
          const result = results.get(candidate.key)!;
          if (result.deleted) {
            cancelBackgroundCompactionForSession(candidate.entry.sessionId);
            result.archived = candidate.archive!.files.map((file) => file.archived);
            result.archiveDirectory = candidate.archive!.directory;
            if (!(await removeArchivedOriginals(candidate.archive!))) {
              result.originalCleanupFailed = true;
            }
          }
        }
      } catch {
        // Keep originals and durable snapshots when the index write is uncertain.
        for (const candidate of candidates) {
          results.set(candidate.key, { key: candidate.key, deleted: false, reason: "store_error" });
        }
      } finally {
        await Promise.allSettled(candidates.map((candidate) => candidate.lock.release()));
      }
    }
    return unique.map((key) => results.get(key)!);
  } finally {
    retiring = false;
  }
}

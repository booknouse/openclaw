import { buildSessionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { TRANSCRIPT_HARD_BYTES } from "../agents/session-transcript-budget.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { scanSessionHistory } from "./session-history-scan.js";

// A transcript can hit the storage threshold through metadata/short turns before token compaction.
// The handoff reader must cover an admitted runtime; its serialized export has a separate 2 MiB cap.
const MAX_CONTEXT_BYTES = TRANSCRIPT_HARD_BYTES;
const MAX_CONTEXT_ENTRIES = 50_000;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
let reading = 0;

/** Retain only the latest committed compaction and its effective tail, never the full log. */
export async function readBoundedSessionContext(
  file: string,
  sessionId: string,
  includeAncestors = false,
) {
  if (reading >= 2) {
    return {
      complete: false,
      reason: "busy",
      entries: [] as SessionEntry[],
      messages: [],
      ancestorsComplete: false,
    };
  }
  reading++;
  try {
    const reverse: SessionEntry[] = [];
    let bytes = 0;
    let firstKept: string | undefined;
    let effectiveComplete = false;
    let limited = false;
    const scan = await scanSessionHistory(
      file,
      sessionId,
      (raw, size) => {
        if (bytes + size > MAX_CONTEXT_BYTES || reverse.length >= MAX_CONTEXT_ENTRIES) {
          limited = true;
          return false;
        }
        bytes += size;
        const entry = raw as SessionEntry;
        reverse.push(entry);
        if (!firstKept && entry.type === "compaction") {
          firstKept = entry.firstKeptEntryId;
        }
        if (entry.id === firstKept || entry.parentId === null) {
          effectiveComplete = true;
        }
        return !effectiveComplete || includeAncestors;
      },
      { maxRecordBytes: MAX_HISTORY_BYTES },
    );
    const complete =
      (effectiveComplete || (scan.complete && !limited && reverse.length === 0)) &&
      scan.reason !== "file_changed";
    const entries = reverse.toReversed();
    const last = entries.findLast((entry) => entry.type === "compaction");
    let contextEntries = entries;
    if (last) {
      // Retained messages' old provider usage describes the pre-compaction prompt, not this context.
      const boundary = entries.indexOf(last);
      contextEntries = entries.map((entry, index) =>
        index < boundary && entry.type === "message" && entry.message.role === "assistant"
          ? { ...entry, message: { ...entry.message, usage: makeZeroUsageSnapshot() } }
          : entry,
      );
    }
    return {
      complete,
      reason: complete
        ? undefined
        : limited
          ? "context_limit"
          : (scan.reason ?? "incomplete_context"),
      entries,
      // Only complete committed snapshots can be used as a recovery handoff.
      messages: complete ? buildSessionContext(contextEntries).messages : [],
      ancestorsComplete: scan.complete && !limited && entries[0]?.parentId === null,
      scan,
    };
  } finally {
    reading--;
  }
}

/** Ordinary chat history is a bounded tail read too, including old-format display-only logs. */
export async function readBoundedRecentHistory(file: string, sessionId: string, limit: number) {
  if (reading >= 2) {
    return { messages: [], historyRead: { complete: false, reason: "busy" } };
  }
  reading++;
  try {
    const messages: unknown[] = [];
    let bytes = 0;
    let limited = false;
    const scan = await scanSessionHistory(
      file,
      sessionId,
      (entry, size) => {
        if (bytes + size > MAX_HISTORY_BYTES) {
          limited = true;
          return false;
        }
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
          bytes += size;
        } else if (entry.type === "compaction") {
          messages.push({
            role: "system",
            content: [{ type: "text", text: "Compaction" }],
            timestamp: Date.parse(entry.timestamp),
            __openclaw: { kind: "compaction", id: entry.id },
          });
        }
        return messages.length < limit;
      },
      { followBranch: false, maxRecordBytes: MAX_HISTORY_BYTES },
    );
    return {
      messages: scan.reason === "file_changed" ? [] : messages.toReversed(),
      historyRead: {
        ...scan,
        complete: scan.complete && !limited,
        ...(limited ? { reason: "response_limit" } : {}),
      },
    };
  } finally {
    reading--;
  }
}

import { stat } from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  scanSessionHistory,
  type HistoryScanStatus,
  type RecallEntry,
} from "./session-history-scan.js";
import { resolveSessionTranscriptCandidates } from "./session-utils.fs.js";

export type HistoryRecallParams = {
  query?: string;
  around?: string;
  limit?: number;
  includeTools?: boolean;
};

const MAX_EXCERPT_CHARS = 2400;
const MAX_RESULTS = 20;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function searchTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const words = [...normalized.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)].map((match) => match[0]);
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike && /\p{Script=Han}/u.test(part.segment)) {
      words.push(part.segment);
    }
  }
  return [...new Set([normalized, ...words])].filter(Boolean).slice(0, 24);
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  // Do not index thinking, credentials in tool arguments, images, or hidden details.
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function excerpt(text: string, matchers: RegExp[]) {
  const hits = matchers
    .map((matcher) => matcher.exec(text)?.index ?? -1)
    .filter((index) => index >= 0);
  const start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 300);
  const end = Math.min(text.length, start + MAX_EXCERPT_CHARS);
  return {
    text: `${start ? "[…earlier text omitted…]\n" : ""}${Buffer.from(text.slice(start, end), "utf8").toString("utf8")}${end < text.length ? "\n[…later text omitted…]" : ""}`,
    truncated: start > 0 || end < text.length,
  };
}

type RecallMessage = {
  historyRef: string;
  role: string;
  timestamp: string;
  content: { type: "text"; text: string }[];
  historyExcerpt: { truncated: boolean; redacted: boolean };
};

function createRecallCollector(sessionId: string, params: HistoryRecallParams) {
  // Resolve configuration once per query, not once for every historical message.
  const logging = loadConfig().logging;
  const redaction = { mode: logging?.redactSensitive, patterns: logging?.redactPatterns };
  const limit = Number.isFinite(params.limit)
    ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(params.limit!)))
    : 5;
  const terms = params.query ? searchTerms(params.query.trim()) : [];
  const matchers = terms.map(
    (term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"),
  );
  const best: { score: number; order: number; message: RecallMessage }[] = [];
  const newer: RecallMessage[] = [];
  const older: RecallMessage[] = [];
  let target: RecallMessage | undefined;
  let matched = 0;
  let order = 0;
  const push = (entry: RecallEntry): boolean => {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
      return true;
    }
    const message = entry.message as Record<string, unknown>;
    const role = message.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      !(params.includeTools && role === "toolResult")
    ) {
      return true;
    }
    const original = messageText(message);
    const text = redactSensitiveText(original, redaction);
    if (!text.trim()) {
      return true;
    }
    const currentOrder = order++;
    const makeMessage = (): RecallMessage => {
      const snippet = excerpt(text, matchers);
      return {
        historyRef: `${sessionId}:${entry.id}`,
        role,
        timestamp: entry.timestamp,
        content: [{ type: "text", text: snippet.text }],
        historyExcerpt: { truncated: snippet.truncated, redacted: text !== original },
      };
    };
    if (params.around) {
      if (target) {
        older.push(makeMessage());
      } else if (`${sessionId}:${entry.id}` === params.around) {
        target = makeMessage();
      } else {
        newer.push(makeMessage());
        if (newer.length >= limit) {
          newer.shift();
        }
      }
      return (
        !target || older.length < limit - 1 - Math.min(newer.length, Math.ceil((limit - 1) / 2))
      );
    }
    const normalized = text.normalize("NFKC");
    const score = terms.reduce(
      (sum, term, index) => sum + (matchers[index].test(normalized) ? term.length : 0),
      0,
    );
    if (!score) {
      return true;
    }
    matched++;
    // Entries arrive newest first. Tied older hits cannot displace a newer hit.
    if (best.length < limit || score > best[best.length - 1].score) {
      best.push({ score, order: currentOrder, message: makeMessage() });
      const sorted = best
        .toSorted((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, limit);
      best.splice(0, best.length, ...sorted);
    }
    return true;
  };
  const result = (scan: HistoryScanStatus) => {
    const discard = scan.reason === "file_changed";
    const messages = discard
      ? []
      : params.around
        ? target
          ? [
              ...older.toReversed(),
              target,
              ...newer.slice(-(limit - older.length - 1)).toReversed(),
            ].slice(0, limit)
          : []
        : best.toSorted((a, b) => b.order - a.order).map((row) => row.message);
    return {
      messages,
      recall: {
        ...scan,
        matched: discard ? 0 : params.around ? messages.length : matched,
        hasMore: !scan.complete || (!params.around && matched > messages.length),
        ...(params.around && !target && scan.complete ? { referenceNotFound: true } : {}),
      },
    };
  };
  return { push, result };
}

/** In-memory adapter for existing branch fixtures and model replay; production uses the scanner. */
export function selectSessionHistoryRecall(
  entries: RecallEntry[],
  sessionId: string,
  params: HistoryRecallParams,
) {
  const collector = createRecallCollector(sessionId, params);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!collector.push(entries[i])) {
      break;
    }
  }
  return collector.result({ complete: true, scannedBytes: 0, scannedRecords: entries.length });
}

const activeSessions = new Set<string>();
const MAX_CONCURRENT_SCANS = 2;

export async function readSessionHistoryRecall(
  params: HistoryRecallParams & {
    sessionId: string;
    storePath: string;
    sessionFile?: string;
  },
) {
  const scope = JSON.stringify([params.storePath, params.sessionId]);
  if (activeSessions.size >= MAX_CONCURRENT_SCANS || activeSessions.has(scope)) {
    return {
      messages: [],
      recall: {
        matched: 0,
        hasMore: true,
        complete: false,
        reason: "busy",
        retryAfterMs: 1000,
        scannedBytes: 0,
        scannedRecords: 0,
      },
    };
  }
  activeSessions.add(scope);
  try {
    for (const file of resolveSessionTranscriptCandidates(
      params.sessionId,
      params.storePath,
      params.sessionFile,
    )) {
      try {
        if (!(await stat(file)).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      const collector = createRecallCollector(params.sessionId, params);
      const scan = await scanSessionHistory(file, params.sessionId, collector.push);
      return collector.result(scan);
    }
    return {
      messages: [],
      recall: {
        matched: 0,
        hasMore: true,
        complete: false,
        unavailable: true,
        reason: "unavailable",
        scannedBytes: 0,
        scannedRecords: 0,
      },
    };
  } finally {
    activeSessions.delete(scope);
  }
}

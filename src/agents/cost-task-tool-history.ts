import fs from "node:fs";
import { scanSessionHistory } from "../gateway/session-history-scan.js";
import { resolveSessionTranscriptCandidates } from "../gateway/session-utils.fs.js";
import { hasUnsettledCostTools } from "./cost-task-continuation.js";

/** Inspect bounded native operational records, not UI-truncated chat history or a model catalog. */
export async function costToolsAreSettled(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
}): Promise<boolean> {
  const file = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
  ).find((candidate) => fs.existsSync(candidate));
  if (!file) {
    return false;
  }
  const messages: unknown[] = [];
  let limited = false;
  const scan = await scanSessionHistory(
    file,
    params.sessionId,
    (entry) => {
      if (entry.type === "compaction") {
        limited = true;
        return false;
      }
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
      return messages.length < 100;
    },
    {
      followBranch: false,
      maxBytes: 4 * 1024 * 1024,
      maxRecordBytes: 1024 * 1024,
      maxRecords: 5000,
      timeoutMs: 1500,
    },
  );
  return (
    scan.complete &&
    !limited &&
    messages.length < 100 &&
    !hasUnsettledCostTools(messages.toReversed())
  );
}

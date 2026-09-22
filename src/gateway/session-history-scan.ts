import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export type RecallEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
};

export const HISTORY_SCAN_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxRecords: 50_000,
  timeoutMs: 1500,
} as const;
type ScanLimits = { [K in keyof typeof HISTORY_SCAN_LIMITS]: number };
export type HistoryScanStatus = {
  complete: boolean;
  reason?: string;
  scannedBytes: number;
  scannedRecords: number;
};

const BLOCK_BYTES = 64 * 1024;
const HEADER_BYTES = 4096;

class ScanStopped extends Error {}

/** Reverse JSONL traversal retains at most one bounded record and one read block. */
async function* reverseLines(
  file: FileHandle,
  size: number,
  limits: ScanLimits,
  status: HistoryScanStatus,
  checkTime: () => void,
) {
  let position = size;
  // Reuse one bounded buffer; concatenating each block creates large external-memory churn.
  const buffer = Buffer.allocUnsafe(limits.maxRecordBytes + BLOCK_BYTES);
  let pendingLength = 0;
  while (position > 0) {
    checkTime();
    const length = Math.min(BLOCK_BYTES, position, limits.maxBytes - status.scannedBytes);
    if (length <= 0) {
      throw new ScanStopped("scan_limit");
    }
    position -= length;
    const start = buffer.length - pendingLength - length;
    const { bytesRead } = await file.read(buffer, start, length, position);
    status.scannedBytes += bytesRead;
    if (bytesRead !== length) {
      throw new ScanStopped("file_changed");
    }
    let end = buffer.length;
    for (
      let newline = buffer.lastIndexOf(10, end - 1);
      newline >= start;
      newline = buffer.lastIndexOf(10, end - 1)
    ) {
      checkTime();
      const line = buffer.subarray(newline + 1, end);
      if (line.length > limits.maxRecordBytes) {
        throw new ScanStopped("record_too_large");
      }
      if (line.length) {
        yield line.toString("utf8");
      }
      end = newline;
      if (end === start) {
        break;
      }
    }
    pendingLength = end - start;
    if (pendingLength > limits.maxRecordBytes) {
      throw new ScanStopped("record_too_large");
    }
    buffer.copy(buffer, buffer.length - pendingLength, start, end);
  }
  if (pendingLength) {
    yield buffer.subarray(buffer.length - pendingLength).toString("utf8");
  }
}

/** Strictly read-only: no SessionManager migration, repair, index, or file creation. */
export async function scanSessionHistory(
  filePath: string,
  sessionId: string,
  visit: (entry: RecallEntry, recordBytes: number) => boolean,
  overrides: Partial<ScanLimits> & { followBranch?: boolean } = {},
): Promise<HistoryScanStatus> {
  const limits = { ...HISTORY_SCAN_LIMITS, ...overrides };
  const status: HistoryScanStatus = { complete: false, scannedBytes: 0, scannedRecords: 0 };
  const deadline = performance.now() + limits.timeoutMs;
  const checkTime = () => {
    if (performance.now() >= deadline) {
      throw new ScanStopped("time_limit");
    }
  };
  let file: FileHandle | undefined;
  let snapshot: Stats | undefined;
  try {
    checkTime();
    file = await open(filePath, "r");
    snapshot = await file.stat();
    const headerBuffer = Buffer.alloc(Math.min(HEADER_BYTES, snapshot.size, limits.maxBytes));
    const { bytesRead } = await file.read(headerBuffer, 0, headerBuffer.length, 0);
    status.scannedBytes += bytesRead;
    const newline = headerBuffer.indexOf(10);
    if (newline < 0) {
      throw new ScanStopped("invalid_header");
    }
    const header = JSON.parse(headerBuffer.subarray(0, newline).toString("utf8"));
    if (header?.type !== "session" || header.id !== sessionId) {
      throw new ScanStopped("invalid_header");
    }
    // Only the current parentId format is supported; never migrate history during a read.
    if (
      header.version !== 3 &&
      !(overrides.followBranch === false && [1, 2].includes(header.version))
    ) {
      throw new ScanStopped("unsupported_format");
    }
    let expectedId: string | null | undefined;
    for await (const line of reverseLines(file, snapshot.size, limits, status, checkTime)) {
      checkTime();
      if (!line.trim()) {
        continue;
      }
      if (status.scannedRecords >= limits.maxRecords) {
        throw new ScanStopped("record_limit");
      }
      status.scannedRecords++;
      // Also yield while a block contains many tiny records, not just on filesystem reads.
      if (status.scannedRecords % 32 === 0) {
        await yieldToEventLoop();
        checkTime();
      }
      const entry = JSON.parse(line) as RecallEntry;
      if (entry.type === "session") {
        if (expectedId !== undefined) {
          throw new ScanStopped("broken_parent_chain");
        }
        status.complete = true;
        break;
      }
      if (overrides.followBranch === false) {
        if (!visit(entry, Buffer.byteLength(line, "utf8"))) {
          status.complete = true;
          break;
        }
        continue;
      }
      if (
        typeof entry.type !== "string" ||
        entry.type.length > 64 ||
        typeof entry.timestamp !== "string" ||
        entry.timestamp.length > 128 ||
        typeof entry.id !== "string" ||
        !entry.id ||
        entry.id.length > 128 ||
        !(
          entry.parentId === null ||
          (typeof entry.parentId === "string" && entry.parentId.length <= 128)
        )
      ) {
        throw new ScanStopped("invalid_record");
      }
      // The final entry is the persisted leaf. Ancestors precede children in native JSONL.
      if (expectedId !== undefined && entry.id !== expectedId) {
        continue;
      }
      expectedId = entry.parentId;
      const keepScanning = visit(entry, Buffer.byteLength(line, "utf8"));
      checkTime();
      if (!keepScanning || expectedId === null) {
        status.complete = true;
        break;
      }
    }
    if (!status.complete) {
      throw new ScanStopped("broken_parent_chain");
    }
  } catch (error) {
    status.complete = false;
    status.reason =
      error instanceof ScanStopped
        ? error.message
        : error instanceof SyntaxError
          ? "invalid_record"
          : "unavailable";
  } finally {
    if (file && snapshot) {
      try {
        const after = await file.stat();
        if (
          after.size !== snapshot.size ||
          after.mtimeMs !== snapshot.mtimeMs ||
          after.ctimeMs !== snapshot.ctimeMs
        ) {
          status.complete = false;
          status.reason = "file_changed";
        }
      } catch {
        status.complete = false;
        status.reason = "file_changed";
      }
    }
    await file?.close();
  }
  return status;
}

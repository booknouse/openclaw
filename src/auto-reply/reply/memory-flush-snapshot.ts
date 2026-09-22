import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";

/** Maintenance owns a separate transcript, run id and session lane; never the live writer. */
export async function createMemoryFlushSnapshot(params: {
  config: OpenClawConfig;
  sessionFile: string;
  sessionKey: string;
  signal: AbortSignal;
}) {
  params.signal.throwIfAborted();
  const source = await fs.readFile(params.sessionFile, "utf8");
  params.signal.throwIfAborted();
  const newline = source.indexOf("\n");
  const header = JSON.parse(newline < 0 ? source : source.slice(0, newline));
  if (header.type !== "session") {
    throw new Error("memory_snapshot_invalid_header");
  }
  const sessionId = randomUUID();
  const root =
    params.config.session?.archive?.directory?.trim() || path.join(resolveStateDir(), "archives");
  const directory = path.join(root, "memory-maintenance", sessionId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(directory, "transcript.jsonl");
  // Preserve completed JSONL entries if the live file was being appended during the read.
  const tail = newline < 0 ? "" : source.slice(newline + 1, source.lastIndexOf("\n") + 1);
  await fs.writeFile(sessionFile, JSON.stringify({ ...header, id: sessionId }) + "\n" + tail, {
    flag: "wx",
    mode: 0o600,
  });
  params.signal.throwIfAborted();
  return {
    sessionId,
    sessionFile,
    sessionKey: `${params.sessionKey}:memory-maintenance:${sessionId}`,
  };
}

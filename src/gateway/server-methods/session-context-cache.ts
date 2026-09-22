import fs from "node:fs";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

type Snapshot = { signature: string; payload: Record<string, unknown> };
const snapshots = new Map<string, Snapshot>();
onSessionTranscriptUpdate(({ sessionFile }) => snapshots.delete(sessionFile));

export function contextFileSignature(file: string, sessionId: string): string {
  const stat = fs.statSync(file);
  return `${sessionId}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function cachedContext(file: string, signature: string) {
  const item = snapshots.get(file);
  if (item?.signature !== signature) {
    return undefined;
  }
  snapshots.delete(file);
  snapshots.set(file, item);
  return item.payload;
}

export function cacheContext(file: string, signature: string, payload: Record<string, unknown>) {
  snapshots.set(file, { signature, payload });
  while (snapshots.size > 256) {
    snapshots.delete(snapshots.keys().next().value!);
  }
}

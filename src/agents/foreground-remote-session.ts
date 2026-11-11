import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const businessSession = /^agent:[^:\s]+:tenant:[^:\s]+:web:[^:\s]+(?::runtime:[^:\s]+)?:role:user$/;
const childSession = /^agent:[^:\s]+:subagent:[^:\s]+$/;
export type ForegroundRemoteContext = { parentSessionKey?: string; parentSessionId?: string };

/** Only product sessions and their persisted descendants opt into shared task management. */
export function foregroundRemoteContext(
  key?: string,
  config?: OpenClawConfig,
): ForegroundRemoteContext | undefined {
  if (!key) {
    return undefined;
  }
  if (businessSession.test(key)) {
    return {};
  }
  if (!childSession.test(key)) {
    return undefined;
  }
  const cfg = config ?? loadConfig();
  const read = (sessionKey: string) => {
    const store = loadSessionStore(
      resolveStorePath(cfg.session?.store, { agentId: resolveAgentIdFromSessionKey(sessionKey) }),
    );
    return (
      store[sessionKey] ??
      Object.entries(store).find(
        ([candidate]) => candidate.toLowerCase() === sessionKey.toLowerCase(),
      )?.[1]
    );
  };
  const seen = new Set<string>();
  let current = key;
  let parent: ForegroundRemoteContext | undefined;
  for (let depth = 0; depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const next = read(current)?.spawnedBy;
    if (!next) {
      return undefined;
    }
    const entry = read(next);
    if (!entry?.sessionId || entry.abortedLastRun) {
      return undefined;
    }
    parent ??= { parentSessionKey: next, parentSessionId: entry.sessionId };
    if (businessSession.test(next)) {
      return parent;
    }
    if (!childSession.test(next)) {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

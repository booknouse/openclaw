import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { retireIdleSessions, type RetirementResult } from "./sessions-retire-batch.js";

export async function retireIdleSession(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry?: SessionEntry;
  deleteTranscript: boolean;
}): Promise<{ ok: true } & Omit<RetirementResult, "key">> {
  // Legacy idle-only callers receive the same permanent archive guarantees.
  const [result] = await retireIdleSessions(params.cfg, [params.key]);
  const { key: _key, ...retirement } = result;
  return { ok: true, ...retirement };
}

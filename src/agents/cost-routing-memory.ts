import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { scanSessionHistory } from "../gateway/session-history-scan.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { isRecord } from "../utils.js";

export type RememberedCostRole = "primary" | "orchestrator";
export type CostRoutingContext = {
  role?: RememberedCostRole;
  goalEntryId: string;
  goal: string;
  lastRequest: string;
  lastAssistant?: string;
};
type RouteRecord = {
  version: 1;
  key: string;
  role: RememberedCostRole;
  userEntryId: string;
  goalEntryId: string;
  updatedAt: number;
};
type Transcript = { sessionId: string; sessionFile: string };
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Read only the current branch's user turns. Never infer identity from message prose. */
async function readUserContext(params: Transcript, goalEntryId?: string) {
  let latest: { id: string; text: string } | undefined;
  let goal: { id: string; text: string } | undefined;
  let lastAssistant: string | undefined;
  const scan = await scanSessionHistory(
    params.sessionFile,
    params.sessionId,
    (entry) => {
      if (entry.type === "compaction") {
        return false;
      }
      if (entry.type !== "message" || !isRecord(entry.message)) {
        return true;
      }
      if (
        !["user", "assistant"].includes(String(entry.message.role)) ||
        hasInterSessionUserProvenance(entry.message)
      ) {
        return true;
      }
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
      const text = blocks
        .filter(
          (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
        )
        .map((block) => String(block.text))
        .join("\n");
      if (entry.message.role === "assistant") {
        if (
          !latest &&
          !lastAssistant &&
          text &&
          text.length <= 32768 &&
          entry.message.stopReason !== "error"
        ) {
          lastAssistant = text;
        }
        return true;
      }
      // Do not silently clip the goal; unavailable context retains normal classification.
      if (!text || text.length > 32768) {
        return false;
      }
      latest ??= { id: entry.id, text };
      if (!goalEntryId || entry.id === goalEntryId) {
        goal = { id: entry.id, text };
        return false;
      }
      return true;
    },
    {
      followBranch: true,
      maxBytes: 4 * 1024 * 1024,
      maxRecordBytes: 1024 * 1024,
      maxRecords: 2000,
      timeoutMs: 500,
    },
  );
  return scan.complete && latest && goal ? { latest, goal, lastAssistant } : undefined;
}

/** Non-authoritative routing hints. Persist entry IDs, never prompts or credentials. */
export class CostRoutingMemory {
  constructor(private directory = path.join(resolveStateDir(), "cost-routing")) {}
  private file(key: string): string {
    return path.join(this.directory, `${digest(key)}.json`);
  }

  private async bootstrap(transcript: Transcript): Promise<CostRoutingContext | undefined> {
    const context = await readUserContext(transcript);
    return context
      ? {
          goalEntryId: context.goal.id,
          goal: context.goal.text,
          lastRequest: context.latest.text,
          lastAssistant: context.lastAssistant,
        }
      : undefined;
  }

  async recall(key: string, transcript: Transcript): Promise<CostRoutingContext | undefined> {
    try {
      const file = this.file(key);
      if ((await fs.stat(file)).size > 4096) {
        return undefined;
      }
      const record: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !isRecord(record) ||
        record.version !== 1 ||
        record.key !== digest(key) ||
        !["primary", "orchestrator"].includes(String(record.role)) ||
        typeof record.userEntryId !== "string" ||
        typeof record.goalEntryId !== "string" ||
        typeof record.updatedAt !== "number" ||
        record.updatedAt > Date.now() ||
        Date.now() - record.updatedAt > MAX_AGE_MS
      ) {
        return undefined;
      }
      const context = await readUserContext(transcript, record.goalEntryId);
      if (!context || context.latest.id !== record.userEntryId) {
        return this.bootstrap(transcript);
      }
      return {
        role: record.role as RememberedCostRole,
        goalEntryId: context.goal.id,
        goal: context.goal.text,
        lastRequest: context.latest.text,
        lastAssistant: context.lastAssistant,
      };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? this.bootstrap(transcript)
        : undefined;
    }
  }

  async remember(
    key: string,
    role: RememberedCostRole,
    transcript: Transcript,
    goalEntryId?: string,
  ): Promise<void> {
    const context = await readUserContext(transcript, goalEntryId);
    if (!context) {
      return;
    }
    const record: RouteRecord = {
      version: 1,
      key: digest(key),
      role,
      userEntryId: context.latest.id,
      goalEntryId: context.goal.id,
      updatedAt: Date.now(),
    };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

export type CostRemoteOwner = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  agentId: string;
  model: string;
  deadlineAt: number;
  startedAt: number;
  routingIndependent?: boolean;
  parentSessionKey?: string;
  parentSessionId?: string;
  extraSystemPrompt?: string;
  thinking?: string;
  executionPolicy?: Pick<
    RunEmbeddedPiAgentParams,
    | "senderIsOwner"
    | "execOverrides"
    | "bashElevated"
    | "disableMessageTool"
    | "requireExplicitMessageTarget"
    | "spawnedBy"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
  >;
};

export type CostRemoteWait = {
  id: string;
  owner: CostRemoteOwner;
  taskId: string;
  toolCallId: string;
  toolName: string;
  state: "waiting" | "ready" | "dispatching" | "consumed" | "cancelled";
  resumeRunId?: string;
};

/** Only new, explicitly cost-owned operations enter this ledger. No historical adoption. */
export class CostRemoteWaitStore {
  constructor(private directory: string) {}

  pending(runId?: string): CostRemoteWait[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (files.length > 100000) {
      throw new Error("Cost wait ledger exceeds its bounded recovery limit");
    }
    return files
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .map((file) => this.read(file.slice(0, -5))!)
      .filter((record) => {
        if (record.state === "consumed" || record.state === "cancelled") {
          // Keep idempotency tombstones beyond Server's event retention window.
          if (record.owner.deadlineAt + 8 * 86400000 < Date.now()) {
            fs.unlinkSync(this.file(record.id));
          }
          return false;
        }
        return !runId || record.owner.runId === runId;
      });
  }

  private file(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error("Invalid cost wait ID");
    }
    return path.join(this.directory, `${id}.json`);
  }

  read(id: string): CostRemoteWait | undefined {
    try {
      const file = this.file(id);
      if (fs.statSync(file).size > 128 * 1024) {
        throw new Error("Cost wait record exceeds limit");
      }
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as CostRemoteWait;
      if (record.id !== id) {
        throw new Error("Cost wait identity mismatch");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  save(record: CostRemoteWait): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(record.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 128 * 1024) {
      throw new Error("Cost wait record exceeds limit");
    }
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(this.directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }

  prepare(
    owner: CostRemoteOwner,
    taskId: string,
    toolCallId: string,
    toolName: string,
  ): CostRemoteWait {
    if (!taskId || taskId.length > 160 || !toolCallId || toolCallId.length > 160) {
      throw new Error("Invalid cost remote operation identity");
    }
    const id = createHash("sha256")
      .update(JSON.stringify([owner.runId, owner.sessionId, toolCallId, taskId]))
      .digest("hex");
    const existing = this.read(id);
    if (existing) {
      return existing;
    }
    const record: CostRemoteWait = {
      id,
      owner: { ...owner, startedAt: Date.now() },
      taskId,
      toolCallId,
      toolName,
      state: "waiting",
    };
    this.save(record);
    return record;
  }

  settle(id: string, sessionKey: string, taskId: string): CostRemoteWait {
    const record = this.read(id);
    if (!record || record.owner.sessionKey !== sessionKey || record.taskId !== taskId) {
      throw new Error("Cost completion does not own this wait");
    }
    if (record.state === "waiting") {
      record.state = record.owner.deadlineAt > Date.now() ? "ready" : "cancelled";
      this.save(record);
    }
    return record;
  }
}

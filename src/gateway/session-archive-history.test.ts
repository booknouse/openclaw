import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { resolveArchivedHistory } from "./session-archive-history.js";
import { preparePermanentSessionArchive } from "./session-archive.js";
import { readSessionHistoryRecall } from "./session-history-recall.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("retrieves archived original tool evidence only under the configured root and exact session key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-recall-"));
  dirs.push(dir);
  const root = path.join(dir, "archive");
  await fs.mkdir(root);
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({
    role: "user",
    content: "Q17 old measurement 34; threshold then 28",
    timestamp: 0,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Recorded" }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const key = "agent:alice:tenant:alice:web:conv:runtime:old:role:user";
  const archive = await preparePermanentSessionArchive({
    root,
    key,
    sessionId: manager.getSessionId(),
    agentId: "alice",
    storePath: path.join(dir, "sessions.json"),
    paths: [manager.getSessionFile()!],
  });
  const config = { session: { archive: { directory: root } } };
  const resolved = await resolveArchivedHistory(config, key, archive.directory);
  const result = await readSessionHistoryRecall({ ...resolved, query: "Q17" });
  expect(result.messages[0].content[0].text).toContain("measurement 34");
  await expect(
    resolveArchivedHistory(config, "agent:bob:other", archive.directory),
  ).rejects.toThrow("archive_history_unavailable");
  await expect(resolveArchivedHistory(config, key, dir)).rejects.toThrow(
    "archive_history_unavailable",
  );
  const outside = path.join(dir, "outside.jsonl");
  await fs.copyFile(manager.getSessionFile()!, outside);
  await fs.unlink(archive.files[0].archived);
  await fs.symlink(outside, archive.files[0].archived);
  await expect(resolveArchivedHistory(config, key, archive.directory)).rejects.toThrow(
    "archive_history_unavailable",
  );
});

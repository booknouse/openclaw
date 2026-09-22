import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionHistoryRecall } from "./session-history-recall.js";
import { scanSessionHistory, type RecallEntry } from "./session-history-scan.js";

describe("bounded read-only history scanner", () => {
  let dir: string;
  let manager: SessionManager;
  const user = (text: string) =>
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  function answer(text = "Recorded") {
    return manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  const file = () => manager.getSessionFile()!;
  const query = (extra: Record<string, unknown> = {}) =>
    readSessionHistoryRecall({
      sessionId: manager.getSessionId(),
      storePath: path.join(dir, "sessions.json"),
      sessionFile: file(),
      query: "Q17",
      ...extra,
    });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-history-"));
    manager = SessionManager.create(dir, dir);
    user("Q17 first value 34");
    answer();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("matches the persisted active branch across blocks and excludes abandoned branches", async () => {
    const base = user("branch base");
    answer("DISCARDED Q17");
    manager.branch(base);
    user("多字节内容🙂".repeat(15000) + " Q17 latest value 35");
    answer("CURRENT Q17");
    const before = fs.readFileSync(file());
    const metadata = fs.statSync(file());
    const entries: RecallEntry[] = [];
    const status = await scanSessionHistory(file(), manager.getSessionId(), (entry) => {
      entries.push(entry);
      return true;
    });
    expect(status.complete).toBe(true);
    expect(entries.map((entry) => entry.id)).toEqual(
      manager
        .getBranch()
        .map((entry) => entry.id)
        .toReversed(),
    );
    const result = await query();
    expect(JSON.stringify(result.messages)).not.toContain("DISCARDED");
    expect(JSON.stringify(result.messages)).toContain("latest value 35");
    expect(fs.readFileSync(file())).toEqual(before);
    expect(fs.statSync(file()).mtimeMs).toBe(metadata.mtimeMs);
  });

  it("bounds read bytes, record count and elapsed processing, without reporting complete history", async () => {
    for (let i = 0; i < 100; i++) {
      user(`Q17 ${i} ` + "log ".repeat(300));
    }
    const byBytes = await scanSessionHistory(file(), manager.getSessionId(), () => true, {
      maxBytes: 8192,
    });
    expect(byBytes).toMatchObject({ complete: false, reason: "scan_limit" });
    expect(byBytes.scannedBytes).toBeLessThanOrEqual(8192);
    const byRecords = await scanSessionHistory(file(), manager.getSessionId(), () => true, {
      maxRecords: 2,
    });
    expect(byRecords).toMatchObject({ complete: false, reason: "record_limit", scannedRecords: 2 });
    const byTime = await scanSessionHistory(file(), manager.getSessionId(), () => true, {
      timeoutMs: 0,
    });
    expect(byTime).toMatchObject({ complete: false, reason: "time_limit", scannedBytes: 0 });
  });

  it("stops at oversized records instead of holding their full contents or crossing an unknown parent", async () => {
    user("X".repeat(2 * 1024 * 1024));
    answer("Q17 recent result");
    const before = fs.statSync(file());
    const result = await query();
    expect(result.recall).toMatchObject({
      complete: false,
      reason: "record_too_large",
      hasMore: true,
    });
    expect(result.recall.scannedBytes).toBeLessThan(1200 * 1024);
    expect(JSON.stringify(result.messages)).toContain("recent result");
    expect(JSON.stringify(result.messages)).not.toContain("first value");
    expect(fs.statSync(file()).mtimeMs).toBe(before.mtimeMs);
  });

  it.each([
    "",
    "broken header\n",
    JSON.stringify({ type: "session", id: "test", version: 2 }) + "\n",
  ])("does not repair or migrate invalid/old transcripts", async (content) => {
    fs.writeFileSync(file(), content);
    const before = fs.statSync(file());
    const status = await scanSessionHistory(file(), "test", () => true);
    expect(status.complete).toBe(false);
    expect(fs.readFileSync(file(), "utf8")).toBe(content);
    expect(fs.statSync(file()).mtimeMs).toBe(before.mtimeMs);
  });

  it("does not create a missing file or confuse session identities", async () => {
    const missing = path.join(dir, "missing.jsonl");
    expect(await scanSessionHistory(missing, "test", () => true)).toMatchObject({
      complete: false,
      reason: "unavailable",
    });
    expect(fs.existsSync(missing)).toBe(false);
    expect(await scanSessionHistory(file(), "other-session", () => true)).toMatchObject({
      complete: false,
      reason: "invalid_header",
    });
  });

  it("invalidates results if the transcript changes during a scan", async () => {
    let changed = false;
    const status = await scanSessionHistory(file(), manager.getSessionId(), () => {
      if (!changed) {
        changed = true;
        user("concurrent update");
      }
      return true;
    });
    expect(status).toMatchObject({ complete: false, reason: "file_changed" });
  });

  it("allows event-loop progress during scans and rejects concurrent same-session scans without a queue", async () => {
    for (let i = 0; i < 1000; i++) {
      user(`Q17 ${i}`);
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 0);
    try {
      const first = query();
      const busy = await query();
      expect(busy.recall).toMatchObject({
        complete: false,
        reason: "busy",
        retryAfterMs: 1000,
        scannedBytes: 0,
      });
      const done = await first;
      expect(done.recall.complete).toBe(true);
      expect(ticks).toBeGreaterThan(0);
      expect((await query()).recall.complete).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("caps global scans at two across different sessions and releases slots", async () => {
    const pending = [query()];
    manager = SessionManager.create(dir, dir);
    user("Q17 second session");
    answer();
    pending.push(query());
    manager = SessionManager.create(dir, dir);
    user("Q17 third session");
    answer();
    const busy = await query();
    expect(busy.recall).toMatchObject({ reason: "busy", scannedBytes: 0 });
    await Promise.all(pending);
    expect((await query()).recall.complete).toBe(true);
  });

  it("reads neighbors by reference and stops before unrelated older records", async () => {
    user("X".repeat(2 * 1024 * 1024));
    user("neighbor before");
    const id = user("Q17 target");
    user("neighbor after");
    answer();
    const result = await readSessionHistoryRecall({
      sessionId: manager.getSessionId(),
      storePath: path.join(dir, "sessions.json"),
      sessionFile: file(),
      around: `${manager.getSessionId()}:${id}`,
      limit: 3,
    });
    expect(result.recall.complete).toBe(true);
    expect(result.messages.map((message) => message.content[0].text)).toEqual([
      "neighbor before",
      "Q17 target",
      "neighbor after",
    ]);
    expect(result.recall.scannedBytes).toBeLessThan(100 * 1024);
  });
});

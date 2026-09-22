import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateBackgroundContextTokens } from "../agents/background-compaction.js";
import { readBoundedRecentHistory, readBoundedSessionContext } from "./session-bounded-context.js";

describe("bounded active context and recent history", () => {
  let dir: string;
  let manager: SessionManager;
  const user = (content: string) => manager.appendMessage({ role: "user", content, timestamp: 0 });
  const answer = (content: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: 0,
      usage: {
        input: 200000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 200001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-context-"));
    manager = SessionManager.create(dir, dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads only the committed summary and kept tail, ignoring stale usage without rewriting billing history", async () => {
    user("old history ".repeat(100000));
    answer("old reply");
    const kept = user("Q17 initially 34; target was 40");
    answer("confirmed");
    manager.appendCompaction("Keep Q17; original evidence remains in history", kept, 250000);
    user("Latest correction: target 50, threshold 35");
    const file = manager.getSessionFile()!;
    const before = fs.readFileSync(file);
    const result = await readBoundedSessionContext(file, manager.getSessionId());
    expect(result.complete).toBe(true);
    expect(result.scan!.scannedBytes).toBeLessThan(100 * 1024);
    expect(JSON.stringify(result.messages)).toContain("Latest correction");
    expect(JSON.stringify(result.messages)).not.toContain("old history");
    expect(estimateBackgroundContextTokens(result.messages)).toBeLessThan(1000);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("marks oversized effective context incomplete instead of advertising a truncated handoff", async () => {
    user("old");
    answer("ack");
    for (let i = 0; i < 19; i++) {
      user("data ".repeat(190000));
    }
    const result = await readBoundedSessionContext(
      manager.getSessionFile()!,
      manager.getSessionId(),
    );
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("context_limit");
    expect(result.messages).toHaveLength(0);
  });

  it("reads a bounded recent history window without opening the full session manager", async () => {
    user("large old history ".repeat(200000));
    answer("old");
    user("recent request");
    answer("recent reply");
    const result = await readBoundedRecentHistory(
      manager.getSessionFile()!,
      manager.getSessionId(),
      2,
    );
    expect(result.messages).toHaveLength(2);
    expect(JSON.stringify(result.messages)).toContain("recent request");
    expect(JSON.stringify(result.messages)).not.toContain("large old history");
    expect(result.historyRead.complete).toBe(true);
  });

  it("can hand off many short turns before the first token compaction", async () => {
    for (let i = 0; i < 7000; i++) {
      user(`short request ${i}`);
      answer("recorded");
    }
    user("latest correction: target 50, threshold 35");
    const result = await readBoundedSessionContext(
      manager.getSessionFile()!,
      manager.getSessionId(),
    );
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(14001);
    expect(JSON.stringify(result.messages)).toContain("short request 0");
    expect(JSON.stringify(result.messages)).toContain("target 50, threshold 35");
  });
});

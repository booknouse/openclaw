import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionHistoryRecall, selectSessionHistoryRecall } from "./session-history-recall.js";

describe("session history recall", () => {
  let dir: string;
  let manager: SessionManager;
  const answer = (text: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  const user = (text: string) =>
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  const recall = (params: Parameters<typeof selectSessionHistoryRecall>[2]) =>
    selectSessionHistoryRecall(manager.getBranch(), manager.getSessionId(), params);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-recall-"));
    manager = SessionManager.create(dir, dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("recovers a cold measurement after five compactions and more than 1000 newer messages", async () => {
    user("Run the first eight-point sample under target 40 / threshold 28.");
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "sample",
      toolName: "exec",
      content: [{ type: "text", text: "Q17 SR proxy = 34 V/us; P09 skipped invalid_small_w" }],
      isError: false,
      timestamp: Date.now(),
    });
    answer("Eight-point sample passed.");
    const first = recall({ query: "Q17", includeTools: true }).messages[0];
    expect(first.content[0].text).toContain("34 V/us");
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 205; i++) {
        user(`unrelated measurement ${cycle}-${i}`);
      }
      const kept = user("Continue the task.");
      answer("Recorded.");
      manager.appendCompaction(
        "Keep current task; sample passed. Exact results are in history.",
        kept,
        250000,
      );
    }
    user("Correction: target 50, coarse threshold 35. Final ranking is not a hard SR gate.");
    answer("Latest correction recorded.");
    expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("34 V/us");
    const result = await readSessionHistoryRecall({
      sessionId: manager.getSessionId(),
      storePath: path.join(dir, "sessions.json"),
      sessionFile: manager.getSessionFile()!,
      query: "Q17",
      includeTools: true,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ historyRef: first.historyRef, role: "toolResult" });
    expect(result.messages[0].content[0].text).toContain("34 V/us");
    const nearby = recall({ around: first.historyRef, includeTools: true, limit: 3 });
    expect(JSON.stringify(nearby.messages)).toContain("threshold 28");
    expect(JSON.stringify(recall({ query: "threshold" }).messages)).toContain("threshold 35");
  });

  it("only searches the active branch and rejects references from another session", () => {
    const base = user("Shared beginning");
    answer("DISCARDED-Q17 secret result");
    manager.branch(base);
    answer("CURRENT-Q17 verified result");
    expect(JSON.stringify(recall({ query: "Q17" }))).not.toContain("DISCARDED");
    const result = recall({ query: "CURRENT-Q17" });
    expect(result.messages).toHaveLength(1);
    expect(
      recall({ around: `other-session:${result.messages[0].historyRef.split(":").at(-1)}` }),
    ).toMatchObject({ messages: [], recall: { referenceNotFound: true } });
  });

  it("returns a bounded excerpt around a match deep in an oversized tool result", () => {
    user("Run sample");
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "sample",
      toolName: "exec",
      content: [
        {
          type: "text",
          text:
            "unrelated log\n".repeat(10000) +
            "Q17 measured 34 V/us\n" +
            "trailing log\n".repeat(10000),
        },
      ],
      isError: false,
      timestamp: 0,
    });
    answer("Done.");
    expect(recall({ query: "Q17" }).messages).toHaveLength(0);
    const result = recall({ query: "Q17", includeTools: true });
    expect(result.messages[0].content[0].text).toContain("Q17 measured 34 V/us");
    expect(result.messages[0].content[0].text.length).toBeLessThan(2500);
    expect(result.messages[0].historyExcerpt.truncated).toBe(true);
  });

  it("searches Chinese words and identifiers without exposing thinking or tool arguments", () => {
    user("粗筛门槛调整为35，保留CAND-Q17");
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "HIDDEN_REASONING", thinkingSignature: "hidden" },
        { type: "toolCall", id: "tool1", name: "exec", arguments: { secret: "HIDDEN_ARGUMENT" } },
      ],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "toolUse",
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
    expect(recall({ query: "粗筛门槛" }).messages).toHaveLength(1);
    expect(recall({ query: "cand-q17" }).messages).toHaveLength(1);
    expect(recall({ query: "HIDDEN", includeTools: true }).messages).toHaveLength(0);
  });

  it("caps results, marks additional matches, and handles missing history", async () => {
    for (let i = 0; i < 40; i++) {
      user(`Q17 result ${i}`);
    }
    answer("Done");
    const result = recall({ query: "Q17", limit: 1000 });
    expect(result.messages).toHaveLength(20);
    expect(result.recall).toMatchObject({ matched: 40, hasMore: true });
    expect(
      await readSessionHistoryRecall({
        sessionId: "missing",
        storePath: path.join(dir, "sessions.json"),
        query: "Q17",
      }),
    ).toMatchObject({ messages: [], recall: { unavailable: true } });
  });

  it("redacts credentials before searching or returning history excerpts", () => {
    user("Q17 endpoint key sk-1234567890abcdef1234");
    answer("Recorded");
    const result = recall({ query: "Q17" });
    expect(JSON.stringify(result)).not.toContain("sk-1234567890abcdef1234");
    expect(result.messages[0].historyExcerpt.redacted).toBe(true);
    expect(recall({ query: "sk-1234567890abcdef1234" }).messages).toHaveLength(0);
  });
});

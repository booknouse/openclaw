import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const state = vi.hoisted(() => ({ sessionFile: "", sessionId: "" }));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: (sessionKey: string) => ({
    cfg: {},
    storePath: path.join(path.dirname(state.sessionFile), "sessions.json"),
    entry: { sessionId: state.sessionId, sessionFile: state.sessionFile },
    canonicalKey: sessionKey,
  }),
}));
const { chatHandlers } = await import("./chat.js");

describe("chat.history recall routing", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-recall-"));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({
      role: "user",
      content: "Q17 measurement = 34 under the old threshold 28",
      timestamp: 0,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Saved" }],
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
    const kept = manager.appendMessage({
      role: "user",
      content: "Current threshold is 35",
      timestamp: 1,
    });
    manager.appendCompaction("Continue with threshold 35", kept, 250000);
    state.sessionFile = manager.getSessionFile()!;
    state.sessionId = manager.getSessionId();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function request(params: Record<string, unknown>) {
    const respond = vi.fn();
    await chatHandlers["chat.history"]({
      params,
      respond,
      req: { type: "req", id: "recall", method: "chat.history", params },
      context: {} as GatewayRequestContext,
      client: null,
      isWebchatConnect: () => false,
    });
    return respond;
  }

  it("searches before compaction through the validated RPC and returns stable references", async () => {
    const respond = await request({ sessionKey: "agent:main:current", query: "Q17", limit: 1 });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            historyRef: expect.stringContaining(`${state.sessionId}:`),
            content: [{ type: "text", text: "Q17 measurement = 34 under the old threshold 28" }],
          }),
        ],
      }),
    );
    const reference = respond.mock.calls[0][1].messages[0].historyRef;
    const around = await request({ sessionKey: "agent:main:current", around: reference, limit: 2 });
    expect(around.mock.calls[0][1].messages).toHaveLength(2);
  });

  it.each([{ query: " " }, { query: "x".repeat(257) }, { query: "Q17", around: "s:m" }])(
    "rejects malformed recall parameters %j",
    async (extra) => {
      const respond = await request({ sessionKey: "agent:main:current", ...extra });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );
});

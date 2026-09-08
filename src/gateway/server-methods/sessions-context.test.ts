import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionsContext } from "./sessions-context.js";

const fixture = vi.hoisted(() => ({ file: "", sessionId: "", exists: true }));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        contextTokens: 270000,
        compaction: { background: { enabled: true } },
      },
    },
  }),
}));
vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: () =>
    fixture.exists
      ? {
          key: { sessionId: fixture.sessionId, sessionFile: fixture.file, contextTokens: 270000 },
        }
      : {},
}));
vi.mock("../session-utils.js", () => ({
  resolveGatewaySessionStoreTarget: () => ({
    storeKeys: ["key"],
    storePath: "/unused",
    agentId: "main",
  }),
  resolveSessionTranscriptCandidates: () => [fixture.file],
}));
vi.mock("../../agents/pi-embedded.js", () => ({ isEmbeddedPiRunActive: () => false }));
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-context-test-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "old fact", timestamp: 0 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ack" }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 100,
      output: 1,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 111,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendMessage({ role: "user", content: "new fact BG-TAIL-7391", timestamp: 1 });
  fixture.file = manager.getSessionFile()!;
  fixture.sessionId = manager.getSessionId();
  fixture.exists = true;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
async function request(params: Record<string, unknown>) {
  const respond = vi.fn();
  await sessionsContext({ params, respond } as unknown as Parameters<typeof sessionsContext>[0]);
  return respond;
}
it("returns one runtime's context and background capability", async () => {
  const reply = await request({ key: "key" });
  expect(reply.mock.calls[0][0]).toBe(true);
  expect(reply.mock.calls[0][1]).toMatchObject({
    sessionId: fixture.sessionId,
    contextTokens: 270000,
    backgroundCompaction: { enabled: true, state: "idle" },
    running: false,
  });
  expect(reply.mock.calls[0][1]).not.toHaveProperty("handoff");
});
it("includes all effective messages only when handoff is requested", async () => {
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.handoff.complete).toBe(true);
  expect(body.handoff.text).toContain("old fact");
  expect(body.handoff.text).toContain("BG-TAIL-7391");
});
it("reports a missing runtime and rejects malformed parameters", async () => {
  fixture.exists = false;
  expect((await request({ key: "key" })).mock.calls[0][1].exists).toBe(false);
  expect((await request({ key: "key", handoff: "yes" })).mock.calls[0][0]).toBe(false);
});

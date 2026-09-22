import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cancelBackgroundCompaction,
  claimBackgroundCompaction,
  releaseBackgroundCompactionSlot,
} from "../../agents/background-compaction-state.js";
import { beginCompaction, endCompaction } from "../../agents/compaction-status.js";
import { recordNativeCompactionResult } from "../../agents/native-compaction-state.js";
import { sessionsContext } from "./sessions-context.js";

const fixture = vi.hoisted(() => ({
  file: "",
  sessionId: "",
  exists: true,
  running: false,
  background: true,
  dedicated: false,
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        contextTokens: 270000,
        compaction: {
          model: fixture.dedicated ? "test/summary" : undefined,
          background: { enabled: fixture.background },
        },
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
vi.mock("../../agents/pi-embedded.js", () => ({ isEmbeddedPiRunActive: () => fixture.running }));
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
  fixture.running = false;
  fixture.background = true;
  fixture.dedicated = false;
});
afterEach(async () => {
  cancelBackgroundCompaction(fixture.file);
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

it("exports the committed summary and retained tail after a later compaction fails", async () => {
  const manager = SessionManager.open(fixture.file);
  const kept = manager.getBranch().at(-1)!;
  manager.appendCompaction("FIRST-SUMMARY-FACT", kept.id, 10000);
  manager.appendMessage({ role: "user", content: "AFTER-SUMMARY-TAIL", timestamp: 2 });
  const committed = manager.getBranch().findLast((entry) => entry.type === "compaction")!;
  setJob(manager, "failed");
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.backgroundCompaction.checkpointVersion).toBe(1);
  expect(body.backgroundCompaction.lastCompactionId).toBe(committed.id);
  expect(body.checkpoint).toMatchObject({
    complete: true,
    sessionId: fixture.sessionId,
    compactionId: committed.id,
    firstKeptEntryId: kept.id,
    tailEntryId: manager.getBranch().at(-1)!.id,
  });
  expect(body.checkpoint.text).toContain("FIRST-SUMMARY-FACT");
  expect(body.checkpoint.text).toContain("BG-TAIL-7391");
  expect(body.checkpoint.text).toContain("AFTER-SUMMARY-TAIL");
});

it("does not advertise a checkpoint while the foreground run can still change history", async () => {
  fixture.running = true;
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.handoff.complete).toBe(true);
  expect(body).not.toHaveProperty("checkpoint");
});

it("provides an initial checkpoint before the first compaction only on explicit request", async () => {
  expect((await request({ key: "key" })).mock.calls[0][1]).not.toHaveProperty("checkpoint");
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.checkpoint.compactionId).toBeNull();
  expect(body.checkpoint.text).toContain("old fact");
});

function setJob(manager: SessionManager, state: "failed" | "ready") {
  const entries = manager.getBranch();
  expect(
    claimBackgroundCompaction(
      fixture.file,
      {
        state,
        sessionId: fixture.sessionId,
        touchedAt: Date.now(),
        controller: new AbortController(),
        snapshotIds: entries.map((entry) => entry.id),
        snapshotHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
        summary: "UNCOMMITTED-PREVIEW",
        preparation: {
          firstKeptEntryId: entries.at(-1)!.id,
          tokensBefore: 10000,
          messagesToSummarize: [],
        },
      },
      4,
    ),
  ).toBe(true);
  releaseBackgroundCompactionSlot();
}

it("exports a committed checkpoint separately from a ready summary preview", async () => {
  const manager = SessionManager.open(fixture.file);
  const kept = manager.getBranch().at(-1)!;
  manager.appendCompaction("COMMITTED-FACT", kept.id, 10000);
  manager.appendMessage({ role: "user", content: "LATEST-TAIL", timestamp: 2 });
  setJob(manager, "ready");
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.backgroundCompaction.state).toBe("ready");
  expect(body.handoff.text).toContain("UNCOMMITTED-PREVIEW");
  expect(body.checkpoint.text).toContain("COMMITTED-FACT");
  expect(body.checkpoint.text).not.toContain("UNCOMMITTED-PREVIEW");
  expect(body.checkpoint.text).toContain("LATEST-TAIL");
});

it("advertises on-demand ownership independently of proactive compaction", async () => {
  fixture.background = false;
  fixture.dedicated = true;
  const body = (await request({ key: "key", handoff: true })).mock.calls[0][1];
  expect(body.backgroundCompaction).toMatchObject({
    enabled: false,
    mode: "on-demand",
    state: "idle",
    checkpointVersion: 1,
  });
  expect(body.checkpoint.complete).toBe(true);
  recordNativeCompactionResult(fixture.file, false);
  const failed = (await request({ key: "key" })).mock.calls[0][1];
  expect(failed.backgroundCompaction).toMatchObject({
    mode: "on-demand",
    state: "failed",
    reason: "native_compaction_failed",
  });
  recordNativeCompactionResult(fixture.file, true);
  expect((await request({ key: "key" })).mock.calls[0][1].backgroundCompaction.state).toBe("idle");
});

it("reuses unchanged context without reopening the transcript and invalidates after append", async () => {
  const open = vi.spyOn(SessionManager, "open");
  try {
    await request({ key: "key" });
    await request({ key: "key" });
    expect(open).toHaveBeenCalledTimes(1);
    const manager = SessionManager.open(fixture.file);
    manager.appendMessage({ role: "user", content: "changed", timestamp: 10 });
    open.mockClear();
    await request({ key: "key" });
    expect(open).toHaveBeenCalledOnce();
  } finally {
    open.mockRestore();
  }
});
it("reads live compression lock even when the usage snapshot is cached", async () => {
  fixture.background = false;
  fixture.dedicated = true;
  await request({ key: "key" });
  const op = beginCompaction(fixture.sessionId, "key");
  try {
    const busy = (await request({ key: "key" })).mock.calls[0][1];
    expect(busy.compaction.blocking).toBe(true);
    expect(busy.running).toBe(true);
    expect((await request({ key: "key", handoff: true })).mock.calls[0][1]).not.toHaveProperty(
      "checkpoint",
    );
    expect(busy.backgroundCompaction.state).toBe("running");
    expect(busy.contextCapabilities.rejectIfCompacting).toBe(true);
  } finally {
    endCompaction(fixture.sessionId, op, "succeeded");
  }
  const idle = (await request({ key: "key" })).mock.calls[0][1];
  expect(idle.compaction.blocking).toBe(false);
});

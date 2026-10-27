import { afterEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  vi.useRealTimers();
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
});

function createProcessSessionHarness(sessionId: string) {
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  return { processTool, session };
}

async function pollSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
  timeout?: number | string,
) {
  return processTool.execute(callId, {
    action: "poll",
    sessionId,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

function retryMs(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { retryInMs?: number }).retryInMs;
}

function pollStatus(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { status?: string }).status;
}

async function expectCompletedPollWithTimeout(params: {
  sessionId: string;
  callId: string;
  timeout: number | string;
  advanceMs: number;
  assertUnresolvedAtMs?: number;
}) {
  vi.useFakeTimers();
  try {
    const { processTool, session } = createProcessSessionHarness(params.sessionId);

    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = pollSession(processTool, params.callId, params.sessionId, params.timeout);
    if (params.assertUnresolvedAtMs !== undefined) {
      let resolved = false;
      void pollPromise.finally(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(params.assertUnresolvedAtMs);
      expect(resolved).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(params.advanceMs);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
}

test("process poll waits for completion when timeout is provided", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess",
    callId: "toolcall",
    timeout: 2000,
    advanceMs: 100,
  });
});

test("process poll accepts string timeout values", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess-2",
    callId: "toolcall",
    timeout: "2000",
    advanceMs: 350,
  });
});

test("process poll coalesces concurrent no-output polls into one wait", async () => {
  vi.useFakeTimers();
  const sessionId = "sess-retry";
  const { processTool } = createProcessSessionHarness(sessionId);
  const pending = Promise.all(
    [1, 2, 3, 4, 5].map((n) => pollSession(processTool, `call-${n}`, sessionId)),
  );
  await vi.advanceTimersByTimeAsync(5000);
  const polls = await pending;
  expect(polls.map(retryMs)).toEqual([10000, 10000, 10000, 10000, 10000]);
  expect(polls.filter((p) => (p.details as { coalesced?: boolean }).coalesced)).toHaveLength(4);
});

test("process poll resets retryInMs when output appears and clears on completion", async () => {
  vi.useFakeTimers();
  const sessionId = "sess-reset";
  const { processTool, session } = createProcessSessionHarness(sessionId);
  const first = pollSession(processTool, "first", sessionId);
  await vi.advanceTimersByTimeAsync(5000);
  expect(retryMs(await first)).toBe(10000);
  const second = pollSession(processTool, "second", sessionId);
  await vi.advanceTimersByTimeAsync(10000);
  expect(retryMs(await second)).toBe(30000);
  const next = pollSession(processTool, "output", sessionId);
  appendOutput(session, "stdout", "step complete\n");
  await vi.advanceTimersByTimeAsync(100);
  expect(retryMs(await next)).toBe(5000);
  markExited(session, 0, null, "completed");
  const done = await pollSession(processTool, "finished", sessionId);
  expect(pollStatus(done)).toBe("completed");
  expect(retryMs(done)).toBeUndefined();
});

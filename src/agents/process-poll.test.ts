import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addSession,
  appendOutput,
  markExited,
  deleteSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import { pollProcess } from "./process-poll.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
});
function session(id = "quiet") {
  const s = createProcessSessionFixture({ id, backgrounded: true });
  addSession(s);
  return s;
}

it("enforces increasing waits for short or zero empty polls", async () => {
  const s = session();
  for (const [index, ms] of [5000, 10000, 30000, 60000, 60000].entries()) {
    let settled = false;
    const promise = pollProcess(s, index % 2 ? 0 : 1000, `call-${index}`).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).waitedMs).toBe(ms);
  }
});

it("shares the wait and one output drain across callers, including a cancelled leader", async () => {
  const s = session();
  const controller = new AbortController();
  const leader = pollProcess(s, 1000, "leader", controller.signal);
  const rejected = expect(leader).rejects.toMatchObject({ name: "AbortError" });
  const second = pollProcess(s, 1000, "second");
  const third = pollProcess(s, 1000, "third");
  controller.abort();
  await rejected;
  appendOutput(s, "stdout", "new progress\n");
  await vi.advanceTimersByTimeAsync(1);
  expect(await second).toMatchObject({ stdout: "new progress\n", coalesced: true });
  expect(await third).toMatchObject({ stdout: "new progress\n", coalesced: true });
  expect(s.pendingStdout).toEqual([]);
});

it("all cancelled waiters leave output available for the next poll", async () => {
  const s = session();
  const controller = new AbortController();
  const p = pollProcess(s, 1000, "cancel", controller.signal);
  const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
  appendOutput(s, "stdout", "kept");
  const next = pollProcess(s, 1000, "next");
  await vi.advanceTimersByTimeAsync(1);
  expect((await next).stdout).toBe("kept");
});

it("returns early on exit and rejects removed sessions without leaking a wait", async () => {
  const s = session();
  const p = pollProcess(s, 60000, "wait");
  await vi.advanceTimersByTimeAsync(200);
  markExited(s, 9, null, "failed");
  await vi.advanceTimersByTimeAsync(100);
  expect(await p).toMatchObject({ exited: true, exitCode: 9, retryInMs: undefined });
  const removed = session("removed");
  const q = pollProcess(removed, 60000, "removed");
  const assertion = expect(q).rejects.toThrow("removed");
  deleteSession(removed.id);
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
});

it("does not share a result with a caller outside the process scope", async () => {
  const s = session();
  s.scopeKey = "owner";
  const owner = createProcessTool({ scopeKey: "owner" });
  const other = createProcessTool({ scopeKey: "other" });
  const p = owner.execute("owner", { action: "poll", sessionId: s.id });
  const hidden = await other.execute("other", { action: "poll", sessionId: s.id });
  expect(JSON.stringify(hidden)).not.toContain("secret result");
  appendOutput(s, "stdout", "secret result");
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.stringify(await p)).toContain("secret result");
});

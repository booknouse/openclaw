import { afterEach, expect, it } from "vitest";
import { resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getFinishedSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  resetHeartbeatWakeStateForTests();
});
it("notifies for a quiet background job and acknowledges completion without dropping unrelated events", async () => {
  const key = "agent:worker:main";
  const exec = createExecTool({ sessionKey: key, scopeKey: key, notifyOnExit: true });
  const result = await exec.execute("start", {
    command: `"${process.execPath}" -e "setTimeout(()=>process.exit(0),80)"`,
    background: true,
  });
  const id = (result.details as { sessionId: string }).sessionId;
  await expect.poll(() => getFinishedSession(id)).toBeTruthy();
  expect(peekSystemEventEntries(key)).toEqual([
    expect.objectContaining({
      contextKey: `exec:${id}:exit`,
      text: expect.stringContaining("Exec completed"),
    }),
  ]);
  enqueueSystemEvent("keep unrelated event", { sessionKey: key, contextKey: "cron:keep" });
  const processTool = createProcessTool({ scopeKey: key });
  const completed = await processTool.execute("poll", { action: "poll", sessionId: id });
  expect(completed.details).toMatchObject({ status: "completed" });
  expect(peekSystemEventEntries(key).map((e) => e.text)).toEqual(["keep unrelated event"]);
  await processTool.execute("poll-again", { action: "poll", sessionId: id });
  expect(peekSystemEventEntries(key).map((e) => e.text)).toEqual(["keep unrelated event"]);
});

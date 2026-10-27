import type { AssistantMessage } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
const info = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ info }) }));
import { observeProcessPollUsage } from "./process-observation.js";
import { makeZeroUsageSnapshot } from "./usage.js";

it("logs actual input/output/cache usage once for a polling-only response, not mixed work", () => {
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "poll-id",
        name: "process",
        arguments: { action: "poll", sessionId: "job" },
      },
    ],
    provider: "test",
    model: "test",
    api: "openai-completions",
    stopReason: "toolUse",
    timestamp: 1,
    usage: { ...makeZeroUsageSnapshot(), input: 100, output: 2, cacheRead: 50, totalTokens: 152 },
  };
  observeProcessPollUsage(message, "run", "agent:worker:main");
  observeProcessPollUsage(message, "run", "agent:worker:main");
  observeProcessPollUsage(
    {
      ...message,
      content: [
        ...message.content,
        { type: "toolCall", id: "other", name: "exec", arguments: { command: "private command" } },
      ],
    },
    "run",
    "agent:worker:main",
  );
  expect(info).toHaveBeenCalledOnce();
  expect(info).toHaveBeenCalledWith(
    "process.poll.model_usage",
    expect.objectContaining({
      toolCallIds: ["poll-id"],
      input: 100,
      output: 2,
      cacheRead: 50,
      total: 152,
    }),
  );
  expect(JSON.stringify(info.mock.calls)).not.toContain("private command");
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { costToolsAreSettled } from "./cost-task-tool-history.js";

async function fixture(
  messages: unknown[],
  run: (params: { sessionId: string; storePath: string; sessionFile: string }) => Promise<void>,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-tool-history-"));
  const sessionId = "synthetic-session";
  const sessionFile = path.join(directory, `${sessionId}.jsonl`);
  const lines = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: directory,
    },
    ...messages.map((message, index) => ({
      type: "message",
      id: `m${index}`,
      parentId: index ? `m${index - 1}` : null,
      timestamp: new Date(index).toISOString(),
      message,
    })),
  ];
  await fs.writeFile(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  try {
    await run({ sessionId, sessionFile, storePath: path.join(directory, "sessions.json") });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

it("reads terminal metadata even when tool stdout exceeds UI text truncation limits", async () => {
  await fixture(
    [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "one", name: "remote_run", arguments: {} }],
      },
      {
        role: "toolResult",
        toolName: "remote_run",
        toolCallId: "one",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "completed",
              exit_code: 0,
              task_id: "job",
              stdout: "x".repeat(100000),
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial work, all operations settled." }],
      },
    ],
    async (params) => {
      expect(await costToolsAreSettled(params)).toBe(true);
    },
  );
});

it("does not authorize replay of a remote task that has not settled", async () => {
  await fixture(
    [
      {
        role: "toolResult",
        toolName: "remote_run",
        toolCallId: "one",
        content: [{ type: "text", text: '{"status":"running","task_id":"existing"}' }],
      },
      { role: "assistant", content: [{ type: "text", text: "Partial work." }] },
    ],
    async (params) => {
      expect(await costToolsAreSettled(params)).toBe(false);
    },
  );
});

it("fails closed rather than guessing when the bounded operational window is incomplete", async () => {
  await fixture(
    Array.from({ length: 101 }, () => ({
      role: "assistant",
      content: [{ type: "text", text: "synthetic" }],
    })),
    async (params) => {
      expect(await costToolsAreSettled(params)).toBe(false);
    },
  );
});

it("rejects a transcript with the wrong session identity or missing file", async () => {
  await fixture(
    [{ role: "assistant", content: [{ type: "text", text: "synthetic" }] }],
    async (params) => {
      expect(
        await costToolsAreSettled({
          ...params,
          sessionId: "another-session",
          sessionFile: undefined,
        }),
      ).toBe(false);
      expect(await costToolsAreSettled({ ...params, sessionId: "another-session" })).toBe(false);
    },
  );
});

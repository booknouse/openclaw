import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { continueCostTaskOnce } from "./cost-task-continuation.js";
import { costToolsAreSettled } from "./cost-task-tool-history.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const execute = promisify(execFile);

it("recovers a real settled local failure into one verified artifact without another user turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cost-recovery-integration-"));
  const sessionId = "isolated-worker";
  const sessionFile = path.join(root, "worker.jsonl");
  const artifact = path.join(root, "result.json");
  try {
    let exitCode = 0;
    let diagnostic = "";
    try {
      await execute(
        process.execPath,
        [
          "-e",
          "process.stderr.write('Selected implementation cannot handle this input');process.exit(2)",
        ],
        { cwd: root },
      );
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      exitCode = failure.code;
      diagnostic = failure.stderr;
    }
    expect(exitCode).toBe(2);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "attempt", name: "exec", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "attempt",
        toolName: "exec",
        details: { status: "completed", exitCode },
        content: [{ type: "text", text: diagnostic }],
      },
    ];
    await fs.writeFile(
      sessionFile,
      [
        { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() },
        ...messages.map((message, index) => ({
          type: "message",
          id: `m${index}`,
          parentId: index ? `m${index - 1}` : null,
          timestamp: new Date().toISOString(),
          message,
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const entry: SubagentRunRecord = {
      runId: "original",
      childSessionKey: "agent:test:subagent:isolated",
      requesterSessionKey: "agent:test:main",
      requesterDisplayKey: "test",
      task: "Create and verify one artifact in the authorized directory",
      cleanup: "keep",
      createdAt: Date.now(),
      endedAt: Date.now(),
      outcome: { status: "ok" },
      model: "test/worker",
      costTask: {
        deadlineAt: Date.now() + 30000,
        continuations: 0,
        systemPrompt: "Use only the test directory",
        sessionId,
        requesterSessionId: "parent",
      },
      frozenResultText:
        "<cost_task_result>" +
        JSON.stringify({
          status: "blocked",
          remaining: ["Produce the artifact"],
          blocker: "Implementation failed",
          pendingRemoteTasks: [],
          safeToResume: true,
          recovery: {
            kind: "implementation",
            alternative: "Use the runtime's built-in serializer within the same directory",
          },
        }) +
        "</cost_task_result>",
    };
    let dispatches = 0;
    const options = {
      entry,
      now: Date.now,
      isCurrent: () => true,
      inspect: async (recovery?: { kind: string }) =>
        costToolsAreSettled({
          sessionId,
          sessionFile,
          storePath: path.join(root, "sessions.json"),
          requireImplementationFailure: recovery?.kind === "implementation",
        }),
      reserve: (runId: string, seconds: number) => {
        if (entry.costTask!.continuations !== 0 || seconds > 30) {
          return false;
        }
        entry.costTask!.continuations = 1;
        return runId.startsWith("cost-continuation:");
      },
      dispatch: async (runId: string, _seconds: number, message: string) => {
        dispatches++;
        expect(message).toContain("same model, transcript, permissions and deadline");
        await execute(
          process.execPath,
          [
            "-e",
            "require('fs').writeFileSync(process.argv[1],JSON.stringify({verified:true,total:20}),{flag:'wx'})",
            artifact,
          ],
          { cwd: root },
        );
        expect(JSON.parse(await fs.readFile(artifact, "utf8"))).toEqual({
          verified: true,
          total: 20,
        });
        return { runId };
      },
      isAllowed: () => true,
      confirmed: () => {},
      cancelled: async () => {},
      failed: async () => {
        throw new Error("Unexpected dispatch failure");
      },
    };
    expect(await continueCostTaskOnce(options)).toBe(true);
    expect(await continueCostTaskOnce(options)).toBe(false);
    expect(dispatches).toBe(1);
    expect((await fs.readdir(root)).toSorted()).toEqual(["result.json", "worker.jsonl"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

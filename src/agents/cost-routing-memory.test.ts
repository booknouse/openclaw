import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostRoutingMemory } from "./cost-routing-memory.js";

let directory: string;
let transcript: { sessionId: string; sessionFile: string };
let entries: object[];
async function save() {
  await fs.writeFile(
    transcript.sessionFile,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}
function message(id: string, parentId: string | null, role: string, text: string, extra = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }], ...extra },
  };
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-route-memory-"));
  transcript = { sessionId: "native-session", sessionFile: path.join(directory, "session.jsonl") };
  entries = [
    { type: "session", version: 3, id: transcript.sessionId, timestamp: new Date().toISOString() },
    message("goal", null, "user", "Design and implement a constrained optimizer"),
    message("plan", "goal", "assistant", "Proposed implementation and checks"),
  ];
  await save();
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("cost task context memory", () => {
  it("bootstraps existing sessions without inventing a previous route", async () => {
    const context = await new CostRoutingMemory(directory).recall("not-yet-recorded", transcript);
    expect(context).toMatchObject({
      goal: "Design and implement a constrained optimizer",
      lastAssistant: "Proposed implementation and checks",
    });
    expect(context?.role).toBeUndefined();
  });

  it("restores the original task context after restart without persisting text", async () => {
    const store = new CostRoutingMemory(path.join(directory, "routing"));
    await store.remember("session-and-models", "primary", transcript);
    const restarted = new CostRoutingMemory(path.join(directory, "routing"));
    expect(await restarted.recall("session-and-models", transcript)).toEqual({
      role: "primary",
      goalEntryId: "goal",
      goal: "Design and implement a constrained optimizer",
      lastRequest: "Design and implement a constrained optimizer",
      lastAssistant: "Proposed implementation and checks",
    });
    const files = await fs.readdir(path.join(directory, "routing"));
    expect(await fs.readFile(path.join(directory, "routing", files[0]), "utf8")).not.toContain(
      "optimizer",
    );
  });
  it.each(["同意，执行", "Proceed with the plan", "Continuar con lo acordado", "أكمل الخطة"])(
    "keeps the goal across a continuation without language rules: %s",
    async (text) => {
      const store = new CostRoutingMemory(directory);
      await store.remember("key", "primary", transcript);
      entries.push(
        message("approval", "plan", "user", text),
        message("delivery", "approval", "assistant", "result"),
      );
      await save();
      await store.remember("key", "primary", transcript, "goal");
      expect(await store.recall("key", transcript)).toMatchObject({
        goalEntryId: "goal",
        goal: "Design and implement a constrained optimizer",
        lastRequest: text,
      });
    },
  );
  it("records a genuinely new task instead of pinning the old goal", async () => {
    const store = new CostRoutingMemory(directory);
    await store.remember("key", "primary", transcript);
    entries.push(message("new", "plan", "user", "Extract rows from supplied data"));
    await save();
    await store.remember("key", "orchestrator", transcript);
    expect(await store.recall("key", transcript)).toMatchObject({
      role: "orchestrator",
      goalEntryId: "new",
    });
  });
  it("invalidates the hint after an intervening off/direct user turn", async () => {
    const store = new CostRoutingMemory(directory);
    await store.remember("key", "primary", transcript);
    entries.push(message("other", "plan", "user", "another request"));
    await save();
    expect(await store.recall("key", transcript)).toMatchObject({
      goal: "another request",
      lastRequest: "another request",
    });
    expect((await store.recall("key", transcript))?.role).toBeUndefined();
  });
  it("ignores trusted internal completion messages", async () => {
    const store = new CostRoutingMemory(directory);
    await store.remember("key", "primary", transcript);
    entries.push(
      message("child", "plan", "user", "result", { provenance: { kind: "inter_session" } }),
    );
    await save();
    expect((await store.recall("key", transcript))?.role).toBe("primary");
  });
  it("checks native session and model identity", async () => {
    const store = new CostRoutingMemory(directory);
    await store.remember("models-A", "primary", transcript);
    expect((await store.recall("models-B", transcript))?.role).toBeUndefined();
    expect(await store.recall("models-A", { ...transcript, sessionId: "reset" })).toBeUndefined();
  });
  it("does not silently clip oversized or compacted task evidence", async () => {
    const store = new CostRoutingMemory(directory);
    await store.remember("key", "primary", transcript);
    entries.push(message("large", "plan", "user", "x".repeat(32769)));
    await save();
    expect(await store.recall("key", transcript)).toBeUndefined();
    entries.pop();
    entries.push({
      type: "compaction",
      id: "compacted",
      parentId: "plan",
      timestamp: new Date().toISOString(),
    });
    await save();
    expect(await store.recall("key", transcript)).toBeUndefined();
  });
});

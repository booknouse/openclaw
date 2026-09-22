import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMemoryFlushSnapshot } from "./memory-flush-snapshot.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it("gives maintenance its own archived transcript and lane without modifying the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-"));
  directories.push(root);
  const source = path.join(root, "live.jsonl");
  const data =
    JSON.stringify({ type: "session", id: "live", version: 3 }) +
    "\n" +
    JSON.stringify({ type: "message", id: "entry", message: { role: "user", content: "fact" } }) +
    "\n";
  await fs.writeFile(source, data);
  const snapshot = await createMemoryFlushSnapshot({
    config: { session: { archive: { directory: path.join(root, "archive") } } },
    sessionFile: source,
    sessionKey: "agent:main:live",
    signal: new AbortController().signal,
  });
  expect(snapshot.sessionId).not.toBe("live");
  expect(snapshot.sessionFile).toContain(path.join(root, "archive", "memory-maintenance"));
  expect(snapshot.sessionKey).toContain(":memory-maintenance:");
  const entries = (await fs.readFile(snapshot.sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries[0].id).toBe(snapshot.sessionId);
  expect(entries[1].id).toBe("entry");
  await fs.appendFile(snapshot.sessionFile, "maintenance result\n");
  expect(await fs.readFile(source, "utf8")).toBe(data);
});

it("does no filesystem work for an already cancelled task", async () => {
  await expect(
    createMemoryFlushSnapshot({
      config: {},
      sessionFile: "/not-present",
      sessionKey: "test",
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

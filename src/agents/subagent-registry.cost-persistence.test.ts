import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  resolveSubagentRegistryPath,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

it("preserves the last valid cost reservation when atomic replacement fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-reservation-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  const run: SubagentRunRecord = {
    runId: "initial",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "synthetic",
    cleanup: "keep",
    createdAt: 1,
    costTask: { deadlineAt: 60000, continuations: 0 },
  };
  try {
    saveSubagentRegistryToDisk(new Map([[run.runId, run]]), { atomic: true });
    const pathname = resolveSubagentRegistryPath();
    const before = await fs.readFile(pathname, "utf8");
    const next = { ...run, costTask: { ...run.costTask!, continuations: 1 } };
    const rename = vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => {
      throw new Error("synthetic rename failure");
    });
    expect(() =>
      saveSubagentRegistryToDisk(new Map([[next.runId, next]]), { atomic: true }),
    ).toThrow("rename failure");
    rename.mockRestore();
    expect(await fs.readFile(pathname, "utf8")).toBe(before);
    expect(
      (await fs.readdir(path.dirname(pathname))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    saveSubagentRegistryToDisk(new Map([[next.runId, next]]), { atomic: true });
    expect(
      JSON.parse(await fs.readFile(pathname, "utf8")).runs.initial.costTask.continuations,
    ).toBe(1);
    if (process.platform !== "win32") {
      expect((await fs.stat(pathname)).mode & 0o777).toBe(0o600);
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

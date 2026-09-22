import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertSessionTranscriptBudget,
  TRANSCRIPT_HARD_BYTES,
} from "./session-transcript-budget.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects huge or corrupt transcripts before opening them and preserves their bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-budget-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "invalid transcript");
  fs.truncateSync(file, TRANSCRIPT_HARD_BYTES);
  const before = fs.statSync(file);
  await expect(assertSessionTranscriptBudget(file)).rejects.toMatchObject({
    code: "SESSION_TRANSCRIPT_LIMIT",
  });
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  fs.truncateSync(file, TRANSCRIPT_HARD_BYTES - 1);
  await expect(assertSessionTranscriptBudget(file)).resolves.toBeUndefined();
  await expect(assertSessionTranscriptBudget(path.join(dir, "missing"))).resolves.toBeUndefined();
});

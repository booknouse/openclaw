import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enforceSessionDiskBudget } from "../config/sessions/disk-budget.js";
import { SessionSchema } from "../config/zod-schema.session.js";
import {
  preparePermanentSessionArchive,
  removeArchivedOriginals,
  resolvePermanentArchiveDirectory,
} from "./session-archive.js";
import { cleanupArchivedSessionTranscripts } from "./session-utils.fs.js";

let temporary: string;
let sessions: string;
let root: string;
let source: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-permanent-archive-"));
  sessions = path.join(temporary, "sessions");
  root = path.join(temporary, "permanent");
  await fs.mkdir(sessions);
  await fs.mkdir(root);
  source = path.join(sessions, "session.jsonl");
  await fs.writeFile(source, '{"type":"message","text":"保留完整历史"}\n');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});
const prepare = () =>
  preparePermanentSessionArchive({
    root,
    key: "agent:main:closed",
    sessionId: "sid",
    agentId: "main",
    storePath: path.join(sessions, "sessions.json"),
    paths: [source],
  });

it("requires a configurable absolute directory without a hardcoded default", async () => {
  expect(SessionSchema.safeParse({ archive: { directory: root } }).success).toBe(true);
  for (const directory of ["", "   ", "relative/path"]) {
    expect(SessionSchema.safeParse({ archive: { directory } }).success).toBe(false);
  }
  await expect(
    resolvePermanentArchiveDirectory({}, [path.join(sessions, "sessions.json")]),
  ).rejects.toThrow("required");
  expect(
    await resolvePermanentArchiveDirectory({ session: { archive: { directory: root } } }, [
      path.join(sessions, "sessions.json"),
    ]),
  ).toBe(await fs.realpath(root));
});
it("rejects live-directory overlap including symlinks", async () => {
  const link = path.join(temporary, "linked-sessions");
  await fs.symlink(sessions, link, "dir");
  for (const directory of [sessions, path.join(sessions, "archive"), path.join(link, "archive")]) {
    await expect(
      resolvePermanentArchiveDirectory({ session: { archive: { directory } } }, [
        path.join(sessions, "sessions.json"),
      ]),
    ).rejects.toThrow("overlaps");
  }
});
it("saves full content and metadata before removing any original", async () => {
  const original = await fs.readFile(source);
  const archive = await prepare();
  expect(await fs.readFile(source)).toEqual(original);
  expect(await fs.readFile(archive.files[0].archived)).toEqual(original);
  expect(
    JSON.parse(await fs.readFile(path.join(archive.directory, "manifest.json"), "utf8")),
  ).toMatchObject({ sessionKey: "agent:main:closed", sessionId: "sid", kind: "runtime-snapshot" });
  expect(await removeArchivedOriginals(archive)).toBe(true);
  await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(archive.files[0].archived)).toEqual(original);
});
it("never overwrites snapshots or changes them when the source resumes", async () => {
  const first = await prepare();
  const original = await fs.readFile(first.files[0].archived);
  await fs.appendFile(source, "a later turn\n");
  const second = await prepare();
  expect(first.directory).not.toBe(second.directory);
  expect(await fs.readFile(first.files[0].archived)).toEqual(original);
  expect(await removeArchivedOriginals(first)).toBe(false);
  expect(await fs.readFile(source, "utf8")).toContain("a later turn");
});
it("preserves originals on copy failure and rejects missing transcripts", async () => {
  const copy = vi
    .spyOn(fs, "copyFile")
    .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  await expect(prepare()).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await fs.readFile(source, "utf8")).toContain("保留完整历史");
  copy.mockRestore();
  await fs.unlink(source);
  await expect(prepare()).rejects.toThrow("missing");
});
it("keeps permanent snapshots through expiration and disk-budget maintenance", async () => {
  const archive = await prepare();
  const content = await fs.readFile(archive.files[0].archived);
  await removeArchivedOriginals(archive);
  const legacy = path.join(sessions, "old.jsonl.deleted.2000-01-01T00-00-00.000Z");
  await fs.writeFile(legacy, "old disposable archive");
  const storePath = path.join(sessions, "sessions.json");
  await fs.writeFile(storePath, "{}");
  const cleanup = await cleanupArchivedSessionTranscripts({
    directories: [sessions],
    olderThanMs: 1,
    reason: "deleted",
  });
  expect(cleanup.removed).toBe(1);
  await enforceSessionDiskBudget({
    store: {},
    storePath,
    maintenance: { maxDiskBytes: 1, highWaterBytes: 0 },
    warnOnly: false,
  });
  expect(await fs.readFile(archive.files[0].archived)).toEqual(content);
  expect(
    JSON.parse(await fs.readFile(path.join(archive.directory, "manifest.json"), "utf8")),
  ).toHaveProperty("sessionId", "sid");
});

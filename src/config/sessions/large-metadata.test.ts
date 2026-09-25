import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  preparePermanentSessionArchive,
  removeArchivedOriginals,
} from "../../gateway/session-archive.js";
import { copySessionEntryDescriptors, sessionMetadataDirectory } from "./large-metadata.js";
import {
  clearSessionStoreCacheForTest,
  cleanupSessionStoreMetadata,
  loadSessionStore,
  migrateSessionStoreMetadata,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";
import { mergeSessionEntryPreserveActivity, type SessionEntry } from "./types.js";

let root: string;
let storePath: string;
const skills = {
  prompt: "Original skill instructions " + "x".repeat(20_000),
  skills: [{ name: "original" }],
  version: 7,
};
const report: NonNullable<SessionEntry["systemPromptReport"]> = {
  source: "run",
  generatedAt: 123,
  systemPrompt: { chars: 42, projectContextChars: 12, nonProjectContextChars: 30 },
  injectedWorkspaceFiles: [],
  skills: { promptChars: 42, entries: [] },
  tools: { listChars: 0, schemaChars: 0, entries: [] },
};
function entry(id = "test"): SessionEntry {
  return {
    sessionId: id,
    updatedAt: 123,
    sessionFile: path.join(root, `${id}.jsonl`),
    skillsSnapshot: structuredClone(skills),
    systemPromptReport: structuredClone(report),
  };
}
function disk() {
  return JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
}
async function save(store: Record<string, SessionEntry>) {
  await saveSessionStore(storePath, store, { skipMaintenance: true });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-large-metadata-"));
  storePath = path.join(root, "sessions.json");
  clearSessionStoreCacheForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSessionStoreCacheForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("session metadata storage", () => {
  it("shrinks the index, deduplicates snapshots, and preserves fields through cold/cache reads", async () => {
    const original = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`key-${i}`, entry(String(i))]),
    );
    const before = Buffer.byteLength(JSON.stringify(original));
    await save(original);
    expect(fs.statSync(storePath).size).toBeLessThan(before / 20);
    expect(fs.readdirSync(sessionMetadataDirectory(storePath))).toHaveLength(2);
    expect(disk()["key-0"].skillsSnapshot).toBeUndefined();
    expect(disk()["key-0"].metadataRefs?.version).toBe(1);
    for (const skipCache of [true, false, false]) {
      const loaded = loadSessionStore(storePath, { skipCache });
      expect(loaded["key-0"].skillsSnapshot).toEqual(skills);
      expect(loaded["key-1"].systemPromptReport).toEqual(report);
      loaded["key-0"].skillsSnapshot!.skills[0].name = "local mutation";
      expect(loaded["key-1"].skillsSnapshot!.skills[0].name).toBe("original");
    }
  });

  it("does not read metadata during cache cloning, list merges or unrelated store writes", async () => {
    await save({ a: entry("a"), b: entry("b") });
    const read = vi.spyOn(fs, "readFileSync");
    const store = loadSessionStore(storePath);
    const copy = copySessionEntryDescriptors(store.a, { label: "new label" });
    store.a = mergeSessionEntryPreserveActivity(copy, { totalTokens: 42 });
    await save(store);
    loadSessionStore(storePath);
    expect(read.mock.calls.filter(([file]) => typeof file === "number")).toHaveLength(0);
    expect(store.a.skillsSnapshot).toEqual(skills);
    expect(read.mock.calls.filter(([file]) => typeof file === "number")).toHaveLength(1);
  });

  it("preserves spread callers, nested edits, and explicit resets", async () => {
    await save({ a: entry() });
    const store = loadSessionStore(storePath);
    const spread = { ...store.a };
    expect(spread.skillsSnapshot).toEqual(skills);
    store.a.skillsSnapshot!.skills[0].name = "edited";
    store.a.systemPromptReport = undefined;
    await save(store);
    const next = loadSessionStore(storePath);
    expect(next.a.skillsSnapshot!.skills[0].name).toBe("edited");
    expect(next.a.systemPromptReport).toBeUndefined();
    expect(next.a.metadataRefs?.systemPromptReport).toBeUndefined();
    expect(spread.skillsSnapshot!.skills[0].name).toBe("edited");
  });

  it("honors explicit deletion after both a lazy load and an entry spread", async () => {
    await save({ a: entry(), b: entry("b") });
    const store = loadSessionStore(storePath);
    delete store.a.skillsSnapshot;
    store.b = { ...store.b };
    delete store.b.skillsSnapshot;
    await save(store);
    for (const saved of Object.values(loadSessionStore(storePath))) {
      expect(saved.skillsSnapshot).toBeUndefined();
      expect(saved.metadataRefs?.skillsSnapshot).toBeUndefined();
      expect(saved.systemPromptReport).toEqual(report);
    }
  });

  it.each(["structuredClone", "json"])(
    "honors deletion after a %s copy without resurrecting references",
    async (mode) => {
      await save({ a: entry() });
      const loaded = loadSessionStore(storePath).a;
      const copied: SessionEntry =
        mode === "json" ? JSON.parse(JSON.stringify(loaded)) : structuredClone(loaded);
      expect(copied.metadataRefs).toBeUndefined();
      delete copied.skillsSnapshot;
      delete copied.systemPromptReport;
      await save({ a: copied });
      const reread = loadSessionStore(storePath).a;
      expect(reread.skillsSnapshot).toBeUndefined();
      expect(reread.systemPromptReport).toBeUndefined();
      expect(reread.metadataRefs).toBeUndefined();
    },
  );

  it("accepts legacy inline snapshots without rebuilding skills or touching transcript bytes", async () => {
    const original = entry();
    fs.writeFileSync(original.sessionFile!, "original transcript bytes\n");
    fs.writeFileSync(storePath, JSON.stringify({ a: original }));
    const loaded = loadSessionStore(storePath);
    expect(loaded.a.skillsSnapshot).toEqual(skills);
    await save(loaded);
    expect(loadSessionStore(storePath).a.skillsSnapshot).toEqual(skills);
    expect(fs.readFileSync(original.sessionFile!, "utf8")).toBe("original transcript bytes\n");
  });

  it("leaves the previous index intact if publishing a new index fails", async () => {
    const original = JSON.stringify({ a: entry() });
    fs.writeFileSync(storePath, original);
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (to === storePath) {
        throw Object.assign(new Error("injected write failure"), { code: "EIO" });
      }
      return rename(from, to);
    });
    await expect(save({ a: entry() })).rejects.toThrow("injected write failure");
    expect(fs.readFileSync(storePath, "utf8")).toBe(original);
    expect(loadSessionStore(storePath, { skipCache: true }).a.skillsSnapshot).toEqual(skills);
  });

  it("preserves concurrent metadata appends without mutating shared blobs or old readers", async () => {
    await save({ a: entry(), b: entry("b") });
    const oldReader = loadSessionStore(storePath).a;
    const originalRef = disk().a.metadataRefs!.skillsSnapshot!;
    const originalFile = path.join(sessionMetadataDirectory(storePath), `${originalRef}.json`);
    const originalBytes = fs.readFileSync(originalFile);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateSessionStore(
          storePath,
          (store) => {
            store.a.skillsSnapshot!.prompt += ` ${i}`;
            store.a.skillsSnapshot!.skills.push({ name: `added-${i}` });
            store.a.systemPromptReport!.skills.entries.push({ name: `added-${i}`, blockChars: i });
          },
          { skipMaintenance: true },
        ),
      ),
    );
    const current = loadSessionStore(storePath);
    expect(current.a.skillsSnapshot!.skills).toHaveLength(13);
    expect(new Set(current.a.skillsSnapshot!.skills.map((skill) => skill.name)).size).toBe(13);
    expect(current.a.systemPromptReport!.skills.entries).toHaveLength(12);
    expect(current.b.skillsSnapshot).toEqual(skills);
    expect(oldReader.skillsSnapshot).toEqual(skills);
    expect(fs.readFileSync(originalFile)).toEqual(originalBytes);
    expect(disk().a.metadataRefs!.skillsSnapshot).not.toBe(originalRef);
  });

  it("serializes concurrent updates without losing untouched metadata", async () => {
    await save({ a: entry() });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        updateSessionStore(
          storePath,
          (store) => {
            store.a.totalTokens = (store.a.totalTokens ?? 0) + 1;
          },
          { skipMaintenance: true },
        ),
      ),
    );
    const loaded = loadSessionStore(storePath);
    expect(loaded.a.totalTokens).toBe(10);
    expect(loaded.a.skillsSnapshot).toEqual(skills);
    expect(fs.readdirSync(sessionMetadataDirectory(storePath))).toHaveLength(2);
  });

  it("fails closed for missing, corrupt, or escaped metadata references", async () => {
    await save({ a: entry() });
    const original = disk();
    const ref = original.a.metadataRefs!.skillsSnapshot!;
    const file = path.join(sessionMetadataDirectory(storePath), `${ref}.json`);
    fs.writeFileSync(file, "{}");
    expect(() => loadSessionStore(storePath).a.skillsSnapshot).toThrow("checksum");
    fs.unlinkSync(file);
    expect(() => loadSessionStore(storePath).a.skillsSnapshot).toThrow();
    original.a.metadataRefs!.skillsSnapshot = "../../outside";
    fs.writeFileSync(storePath, JSON.stringify(original));
    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      "invalid_session_metadata_reference",
    );
  });

  it.skipIf(process.platform === "win32")("rejects symlink blobs and directories", async () => {
    await save({ a: entry() });
    const file = path.join(
      sessionMetadataDirectory(storePath),
      `${disk().a.metadataRefs!.skillsSnapshot}.json`,
    );
    const outside = path.join(root, "outside.json");
    fs.renameSync(file, outside);
    fs.symlinkSync(outside, file);
    expect(() => loadSessionStore(storePath).a.skillsSnapshot).toThrow();
    fs.unlinkSync(file);
    const directory = sessionMetadataDirectory(storePath);
    fs.renameSync(directory, `${directory}-moved`);
    fs.symlinkSync(`${directory}-moved`, directory);
    expect(() => loadSessionStore(storePath).a.systemPromptReport).toThrow(
      "invalid_session_metadata_directory",
    );
  });
});

describe("migration and archival", () => {
  it("only reclaims old unreferenced blobs, and index backups prevent reclamation", async () => {
    await save({ a: entry() });
    const oldReference = disk().a.metadataRefs!.skillsSnapshot!;
    const oldFile = path.join(sessionMetadataDirectory(storePath), `${oldReference}.json`);
    const changed = entry();
    changed.skillsSnapshot = { ...skills, prompt: "new instructions" };
    await save({ a: changed });
    expect((await cleanupSessionStoreMetadata(storePath, true)).removed).toBe(0);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    for (const name of fs.readdirSync(sessionMetadataDirectory(storePath))) {
      fs.utimesSync(path.join(sessionMetadataDirectory(storePath), name), old, old);
    }
    const backup = `${storePath}.metadata-backup-test`;
    fs.writeFileSync(backup, "retained backup");
    expect((await cleanupSessionStoreMetadata(storePath, true)).blockedByBackups).toBe(true);
    expect(fs.existsSync(oldFile)).toBe(true);
    fs.unlinkSync(backup);
    expect(await cleanupSessionStoreMetadata(storePath)).toMatchObject({ eligible: 1, removed: 0 });
    expect(fs.existsSync(oldFile)).toBe(true);
    expect((await cleanupSessionStoreMetadata(storePath, true)).removed).toBe(1);
    expect(loadSessionStore(storePath).a.skillsSnapshot).toEqual(changed.skillsSnapshot);
    expect(loadSessionStore(storePath).a.systemPromptReport).toEqual(report);
  });

  it("previews without writes, creates a backup, and round-trips to the legacy format", async () => {
    const original = { a: entry() };
    fs.writeFileSync(storePath, JSON.stringify(original));
    const preview = await migrateSessionStoreMetadata(storePath);
    expect(preview.backup).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual(["sessions.json"]);
    const migrated = await migrateSessionStoreMetadata(storePath, { apply: true });
    expect(JSON.parse(fs.readFileSync(migrated.backup!, "utf8"))).toEqual(original);
    expect(migrated.afterBytes).toBeLessThan(migrated.beforeBytes / 10);
    const restored = await migrateSessionStoreMetadata(storePath, { apply: true, inline: true });
    expect(restored.backup).toBeTruthy();
    expect(disk()).toEqual(original);
  });

  it("does not overwrite the index or create a rollback backup when a referenced blob is missing", async () => {
    await save({ a: entry() });
    const original = fs.readFileSync(storePath, "utf8");
    fs.rmSync(sessionMetadataDirectory(storePath), { recursive: true });
    await expect(
      migrateSessionStoreMetadata(storePath, { apply: true, inline: true }),
    ).rejects.toThrow();
    expect(fs.readFileSync(storePath, "utf8")).toBe(original);
    expect(fs.readdirSync(root)).toEqual(["sessions.json"]);
  });

  it("archives self-contained metadata before removing the live transcript", async () => {
    const original = entry();
    fs.writeFileSync(original.sessionFile!, "original transcript bytes\n");
    await save({ a: original });
    const archiveRoot = path.join(root, "archive");
    fs.mkdirSync(archiveRoot);
    const archived = await preparePermanentSessionArchive({
      root: archiveRoot,
      key: "a",
      sessionId: original.sessionId,
      agentId: "test",
      storePath,
      paths: [original.sessionFile!],
      entry: loadSessionStore(storePath).a,
    });
    expect(fs.existsSync(original.sessionFile!)).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(archived.directory, "manifest.json"), "utf8"),
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(archived.directory, manifest.metadata), "utf8"),
    );
    expect(saved).toEqual(original);
    expect(await removeArchivedOriginals(archived)).toBe(true);
    fs.rmSync(sessionMetadataDirectory(storePath), { recursive: true });
    expect(
      JSON.parse(fs.readFileSync(path.join(archived.directory, manifest.metadata), "utf8")),
    ).toEqual(original);
    expect(fs.readFileSync(archived.files[0].archived, "utf8")).toBe("original transcript bytes\n");
  });
});

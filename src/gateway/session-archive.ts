import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";

type ArchivedFile = {
  source: string;
  archived: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
};
export type PermanentSessionArchive = { directory: string; files: ArchivedFile[] };

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = path.dirname(value);
    if (parent === value) {
      throw error;
    }
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

/** Reject overlap even through symlinks, so maintenance never scans this archive directory. */
export async function resolvePermanentArchiveDirectory(
  cfg: OpenClawConfig,
  storePaths: string[],
): Promise<string> {
  const configured = cfg.session?.archive?.directory?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("archive_directory_required");
  }
  const root = await canonicalPath(path.resolve(configured));
  for (const live of [resolveStateDir(), ...storePaths.map((value) => path.dirname(value))]) {
    if (isWithin(await canonicalPath(path.resolve(live)), root)) {
      throw new Error("archive_directory_overlaps_live_sessions");
    }
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function syncFile(file: string) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string) {
  if (process.platform !== "win32") {
    await syncFile(directory);
  }
}

function unchanged(current: Stats, saved: Pick<ArchivedFile, "size" | "mtimeMs" | "ino" | "dev">) {
  return (
    current.size === saved.size &&
    current.mtimeMs === saved.mtimeMs &&
    current.ino === saved.ino &&
    current.dev === saved.dev
  );
}

/** Copy under transcript locks, outside the shared index lock. Never removes a source. */
export async function preparePermanentSessionArchive(params: {
  root: string;
  key: string;
  sessionId: string;
  agentId: string;
  storePath: string;
  paths: string[];
}): Promise<PermanentSessionArchive> {
  const existing: { source: string; stat: Stats }[] = [];
  for (const source of new Set(params.paths)) {
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile()) {
        throw new Error("invalid_session_transcript");
      }
      existing.push({ source, stat });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (!existing.length) {
    throw new Error("session_transcript_missing");
  }
  const directory = await fs.mkdtemp(path.join(params.root, "runtime-"));
  await syncDirectory(params.root);
  const files: ArchivedFile[] = [];
  for (const [index, { source, stat }] of existing.entries()) {
    const archived = path.join(directory, `transcript-${index}.jsonl`);
    // Independent inode: a failed retirement may resume the original session later.
    // Exclusive creation prevents overwrites; copyFile also supports different filesystems.
    await fs.copyFile(source, archived, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await fs.chmod(archived, 0o600);
    await syncFile(archived);
    const [copy, current] = await Promise.all([fs.stat(archived), fs.stat(source)]);
    if (copy.size !== stat.size || !unchanged(current, stat)) {
      throw new Error("session_transcript_changed_during_archive");
    }
    files.push({
      source,
      archived,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      dev: stat.dev,
    });
  }
  const manifest = path.join(directory, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        version: 1,
        archivedAt: new Date().toISOString(),
        sessionKey: params.key,
        sessionId: params.sessionId,
        agentId: params.agentId,
        storePath: params.storePath,
        // Snapshots can remain when a later index update is skipped or fails; they are never purged.
        kind: "runtime-snapshot",
        files,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await syncFile(manifest);
  await syncDirectory(directory);
  return { directory, files };
}

/** Remove only unchanged originals after a successful index write; never remove archived copies. */
export async function removeArchivedOriginals(archive: PermanentSessionArchive): Promise<boolean> {
  let complete = true;
  for (const file of archive.files) {
    try {
      if (!unchanged(await fs.stat(file.source), file)) {
        complete = false;
        continue;
      }
      await fs.unlink(file.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        complete = false;
      }
    }
  }
  return complete;
}

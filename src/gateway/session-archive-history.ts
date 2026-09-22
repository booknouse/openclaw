import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";

function within(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** A trusted caller supplies an archive locator; the immutable manifest must match the session. */
export async function resolveArchivedHistory(
  cfg: OpenClawConfig,
  sessionKey: string,
  directory: string,
) {
  const configured = cfg.session?.archive?.directory;
  if (!configured || !path.isAbsolute(configured) || !path.isAbsolute(directory)) {
    throw new Error("archive_history_unavailable");
  }
  const root = await fs.realpath(configured);
  const archive = await fs.realpath(directory);
  if (!within(root, archive)) {
    throw new Error("archive_history_unavailable");
  }
  const manifestPath = await fs.realpath(path.join(archive, "manifest.json"));
  if (!within(archive, manifestPath)) {
    throw new Error("archive_history_unavailable");
  }
  const handle = await fs.open(manifestPath, "r");
  let manifest;
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) {
      throw new Error("archive_history_unavailable");
    }
    manifest = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  if (
    manifest?.version !== 1 ||
    manifest.sessionKey !== sessionKey ||
    typeof manifest.sessionId !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("archive_history_unavailable");
  }
  const file = manifest.files[0]?.archived;
  if (typeof file !== "string") {
    throw new Error("archive_history_unavailable");
  }
  const resolved = await fs.realpath(file);
  if (!within(archive, resolved)) {
    throw new Error("archive_history_unavailable");
  }
  return {
    sessionId: manifest.sessionId as string,
    sessionFile: resolved,
    storePath: path.join(archive, "sessions.json"),
  };
}

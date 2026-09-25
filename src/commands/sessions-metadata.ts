import path from "node:path";
import {
  cleanupSessionStoreMetadata,
  migrateSessionStoreMetadata,
} from "../config/sessions/store.js";
import type { RuntimeEnv } from "../runtime.js";

export async function sessionsMetadataCommand(
  opts: { store?: string; apply?: boolean; inline?: boolean; gc?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  if (!opts.store?.trim()) {
    throw new Error("An explicit --store path is required.");
  }
  if (opts.inline && opts.gc) {
    throw new Error("--inline and --gc cannot be combined.");
  }
  const storePath = path.resolve(opts.store);
  const result = opts.gc
    ? await cleanupSessionStoreMetadata(storePath, Boolean(opts.apply))
    : await migrateSessionStoreMetadata(storePath, { inline: opts.inline, apply: opts.apply });
  runtime.log(
    JSON.stringify(
      {
        storePath,
        mode: opts.gc ? "gc" : opts.inline ? "inline" : "externalize",
        apply: Boolean(opts.apply),
        ...result,
      },
      null,
      2,
    ),
  );
}

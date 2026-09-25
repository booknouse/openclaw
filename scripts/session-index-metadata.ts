/**
 * Stop writers and retain the whole sessions directory (including *.metadata) before upgrading.
 * Preview: pnpm exec tsx scripts/session-index-metadata.ts /path/to/sessions.json
 * Migrate: append --apply. Roll back before using an older binary: append --inline --apply.
 * Offline GC preview: append --gc. Apply: --gc --apply (unreferenced blobs older than 30 days).
 * GC refuses to remove anything while index backups remain. Keep backups for the rollback window.
 */
import {
  cleanupSessionStoreMetadata,
  migrateSessionStoreMetadata,
} from "../src/config/sessions/store.js";

const [storePath, ...flags] = process.argv.slice(2);
if (
  !storePath ||
  flags.some((flag) => !["--apply", "--inline", "--gc"].includes(flag)) ||
  (flags.includes("--gc") && flags.includes("--inline"))
) {
  throw new Error("Usage: session-index-metadata.ts <sessions.json> [--apply] [--inline | --gc]");
}
console.log(
  JSON.stringify(
    flags.includes("--gc")
      ? await cleanupSessionStoreMetadata(storePath, flags.includes("--apply"))
      : await migrateSessionStoreMetadata(storePath, {
          apply: flags.includes("--apply"),
          inline: flags.includes("--inline"),
        }),
    null,
    2,
  ),
);

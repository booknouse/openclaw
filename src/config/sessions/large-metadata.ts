import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../../infra/json-files.js";
import type { SessionEntry } from "./types.js";

const FIELDS = ["skillsSnapshot", "systemPromptReport"] as const;
type Field = (typeof FIELDS)[number];
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const lazyGetters = new WeakSet<() => unknown>();
// Keep deletion tracking on the shared reference object, invisible to JSON and entry spreads.
const attachedFields = Symbol("session-metadata-fields");
type AttachedRefs = NonNullable<SessionEntry["metadataRefs"]> & { [attachedFields]?: Set<Field> };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function sessionMetadataDirectory(storePath: string): string {
  return `${path.resolve(storePath)}.metadata`;
}

function validateReference(ref: string): void {
  if (!/^[a-f0-9]{64}$/.test(ref)) {
    throw new Error("invalid_session_metadata_reference");
  }
}

function validateRefs(entry: SessionEntry): void {
  if (!entry.metadataRefs) {
    return;
  }
  if (entry.metadataRefs.version !== 1) {
    throw new Error("unsupported_session_metadata_version");
  }
  for (const field of FIELDS) {
    const ref = entry.metadataRefs[field];
    if (ref !== undefined) {
      validateReference(ref);
    }
  }
}

function metadataPath(storePath: string, ref: string): string {
  validateReference(ref);
  const directory = sessionMetadataDirectory(storePath);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("invalid_session_metadata_directory");
  }
  return path.join(directory, `${ref}.json`);
}

function readField<F extends Field>(storePath: string, ref: string, field: F): SessionEntry[F] {
  const fd = fs.openSync(
    metadataPath(storePath, ref),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BLOB_BYTES) {
      throw new Error("invalid_session_metadata_size");
    }
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (hash(text) !== ref) {
    throw new Error("session_metadata_checksum_mismatch");
  }
  const blob = JSON.parse(text) as { version?: number; field?: string; value?: SessionEntry[F] };
  if (blob.version !== 1 || blob.field !== field || !blob.value || typeof blob.value !== "object") {
    throw new Error("invalid_session_metadata_blob");
  }
  return blob.value;
}

function setField(entry: SessionEntry, field: Field, value: SessionEntry[Field]): void {
  Object.defineProperty(entry, field, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Own accessors preserve the existing API and spreads; no prototype mutation. */
export function attachSessionMetadata(storePath: string, entry: SessionEntry): SessionEntry {
  storePath = path.resolve(storePath);
  validateRefs(entry);
  if (entry.metadataRefs) {
    // Public spreads / deep clones carry full values, not internal disk references.
    // Otherwise deleting a field from such a copy can resurrect the old referenced value.
    Object.defineProperty(entry, "metadataRefs", { enumerable: false });
    Object.defineProperty(entry.metadataRefs, attachedFields, {
      value: new Set(FIELDS.filter((field) => entry.metadataRefs?.[field])),
      configurable: true,
    });
  }
  for (const field of FIELDS) {
    if (!entry.metadataRefs?.[field] || Object.hasOwn(entry, field)) {
      continue;
    }
    const get = function (this: SessionEntry) {
      const ref = this.metadataRefs?.[field];
      const value = ref ? readField(storePath, ref, field) : undefined;
      setField(this, field, value);
      return value;
    };
    lazyGetters.add(get);
    Object.defineProperty(entry, field, {
      enumerable: true,
      configurable: true,
      get,
      set(this: SessionEntry, value: SessionEntry[Field]) {
        setField(this, field, value);
      },
    });
  }
  return entry;
}

/** Bulk cache/list operations must not evaluate every metadata accessor. */
export function copySessionEntryDescriptors(
  ...entries: (Partial<SessionEntry> | undefined)[]
): SessionEntry {
  const result = {} as SessionEntry;
  for (const entry of entries) {
    if (entry) {
      Object.defineProperties(result, Object.getOwnPropertyDescriptors(entry));
    }
  }
  return result;
}

function copyWithoutLazyFields(entry: SessionEntry): SessionEntry {
  const descriptors = Object.getOwnPropertyDescriptors(entry);
  if (descriptors.metadataRefs) {
    descriptors.metadataRefs.enumerable = true;
  }
  for (const field of FIELDS) {
    const getter = descriptors[field]?.get;
    if (getter && lazyGetters.has(getter)) {
      delete descriptors[field];
    }
  }
  return Object.defineProperties({}, descriptors) as SessionEntry;
}

export function cloneSessionStore(
  store: Record<string, SessionEntry>,
  storePath?: string,
): Record<string, SessionEntry> {
  const result = structuredClone(
    Object.fromEntries(
      Object.entries(store).map(([key, entry]) => [key, entry && copyWithoutLazyFields(entry)]),
    ),
  ) as Record<string, SessionEntry>;
  if (storePath) {
    for (const entry of Object.values(result)) {
      if (entry && typeof entry === "object") {
        attachSessionMetadata(storePath, entry);
      }
    }
  }
  return result;
}

async function writeField(
  storePath: string,
  field: Field,
  value: SessionEntry[Field],
): Promise<string> {
  const text = JSON.stringify({ version: 1, field, value });
  if (Buffer.byteLength(text) > MAX_BLOB_BYTES) {
    throw new Error("session_metadata_too_large");
  }
  const ref = hash(text);
  const directory = sessionMetadataDirectory(storePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = metadataPath(storePath, ref);
  if (fs.existsSync(file)) {
    // Never replace a corrupt blob referenced by an older index.
    readField(storePath, ref, field);
    return ref;
  }
  await writeTextAtomic(file, text, { mode: 0o600 });
  // Persist immutable blobs before publishing their references in the index.
  for (const target of process.platform === "win32"
    ? [file]
    : [file, directory, path.dirname(directory)]) {
    const handle = await fs.promises.open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return ref;
}

/** Called under the store lock; a failure leaves the previous index intact. */
export async function externalizeSessionMetadata(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<Record<string, SessionEntry>> {
  const result: Record<string, SessionEntry> = {};
  const written = new Map<string, string>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      result[key] = entry;
      continue;
    }
    validateRefs(entry);
    const next = copyWithoutLazyFields(entry);
    const refs: NonNullable<SessionEntry["metadataRefs"]> = { ...next.metadataRefs, version: 1 };
    for (const field of FIELDS) {
      if (!Object.hasOwn(next, field)) {
        if (
          !Object.hasOwn(entry, field) &&
          (entry.metadataRefs as AttachedRefs | undefined)?.[attachedFields]?.has(field)
        ) {
          delete refs[field];
        }
        continue;
      }
      const value = next[field];
      if (value === undefined) {
        delete refs[field];
      } else {
        const signature = hash(JSON.stringify({ field, value }));
        let ref = written.get(signature);
        if (!ref) {
          ref = await writeField(storePath, field, value);
          written.set(signature, ref);
        }
        refs[field] = ref;
      }
      delete next[field];
    }
    if (refs.skillsSnapshot || refs.systemPromptReport) {
      next.metadataRefs = refs;
    } else {
      delete next.metadataRefs;
    }
    result[key] = next;
  }
  return result;
}

/** Materialize one entry for a permanent archive or deliberate rollback. */
export function materializeSessionMetadata(storePath: string, entry: SessionEntry): SessionEntry {
  const source = attachSessionMetadata(storePath, copySessionEntryDescriptors(entry));
  const result = { ...source };
  delete result.metadataRefs;
  return result;
}

/** Offline and opt-in: index backups pin blobs until the operator retires those backups. */
export async function pruneSessionMetadata(
  storePath: string,
  store: Record<string, SessionEntry>,
  apply = false,
): Promise<{ blockedByBackups: boolean; scanned: number; eligible: number; removed: number }> {
  const names = await fs.promises.readdir(path.dirname(storePath));
  const basename = path.basename(storePath);
  const blockedByBackups = names.some(
    (name) => name.startsWith(`${basename}.bak`) || name.startsWith(`${basename}.metadata-backup-`),
  );
  const result = { blockedByBackups, scanned: 0, eligible: 0, removed: 0 };
  if (blockedByBackups || !fs.existsSync(sessionMetadataDirectory(storePath))) {
    return result;
  }
  const referenced = new Set<string>();
  for (const entry of Object.values(store)) {
    validateRefs(entry);
    for (const field of FIELDS) {
      const ref = entry.metadataRefs?.[field];
      if (ref) {
        referenced.add(ref);
      }
    }
  }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const directory = await fs.promises.opendir(sessionMetadataDirectory(storePath));
  for await (const file of directory) {
    if (++result.scanned > 10_000 || result.removed >= 1000) {
      break;
    }
    const match = /^([a-f0-9]{64})\.json$/.exec(file.name);
    if (!match || referenced.has(match[1]) || !file.isFile()) {
      continue;
    }
    const target = metadataPath(storePath, match[1]);
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) {
      continue;
    }
    result.eligible++;
    if (apply) {
      await fs.promises.unlink(target);
      result.removed++;
    }
  }
  return result;
}

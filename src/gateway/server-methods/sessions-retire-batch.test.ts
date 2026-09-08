import { beforeEach, expect, it, vi } from "vitest";
import { retireIdleSessions } from "./sessions-retire-batch.js";

const f = vi.hoisted(() => ({
  stores: {} as Record<
    string,
    Record<string, { sessionId: string; updatedAt: number; acp?: unknown }>
  >,
  active: new Set<string>(),
  queued: new Set<string>(),
  children: new Set<string>(),
  locked: new Set<string>(),
  update: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  prepare: vi.fn(),
  directory: vi.fn(),
  lock: vi.fn(),
  beforeWrite: undefined as undefined | (() => void),
}));
vi.mock("node:fs/promises", () => ({
  default: {
    stat: vi.fn(async () => ({})),
  },
}));
vi.mock("../session-archive.js", () => ({
  resolvePermanentArchiveDirectory: (...args: unknown[]) => f.directory(...args),
  preparePermanentSessionArchive: (...args: unknown[]) => f.prepare(...args),
  removeArchivedOriginals: (...args: unknown[]) => f.remove(...args),
}));
vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive: (id: string) => f.active.has(id),
}));
vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: (key: string) => Number(f.children.has(key)),
}));
vi.mock("../../agents/pi-embedded-runner/lanes.js", () => ({
  resolveSessionLane: (id: string) => id,
}));
vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: (id: string) => Number(f.queued.has(id)),
}));
vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: (...args: unknown[]) => f.lock(...args),
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey: () => "main",
  formatSessionArchiveTimestamp: () => "test-date",
  updateSessionStore: (...args: unknown[]) => f.update(...args),
}));
vi.mock("../session-utils.js", () => ({
  resolveGatewaySessionStoreTarget: ({
    key,
    storeCache,
  }: {
    key: string;
    storeCache: Map<string, unknown>;
  }) => {
    const storePath = key.startsWith("other:") ? "other" : "main";
    storeCache.set(storePath, structuredClone(f.stores[storePath]));
    return { canonicalKey: key, storePath, agentId: "main", storeKeys: [key] };
  },
  resolveSessionTranscriptCandidates: (id: string) => [`/${id}.jsonl`],
}));
beforeEach(() => {
  f.stores = { main: {}, other: {} };
  for (let i = 0; i < 20; i++) {
    f.stores.main[`key${i}`] = { sessionId: `sid${i}`, updatedAt: 1 };
  }
  f.active.clear();
  f.queued.clear();
  f.children.clear();
  f.locked.clear();
  f.release.mockReset();
  f.remove.mockReset();
  f.remove.mockResolvedValue(true);
  f.directory.mockReset();
  f.directory.mockResolvedValue("/archive");
  f.prepare.mockReset();
  f.prepare.mockImplementation(async ({ sessionId }: { sessionId: string }) => ({
    directory: `/archive/${sessionId}`,
    files: [{ archived: `/archive/${sessionId}/transcript.jsonl` }],
  }));
  f.beforeWrite = undefined;
  f.lock.mockReset();
  f.lock.mockImplementation(async ({ sessionFile }: { sessionFile: string }) => {
    if (f.locked.has(sessionFile)) {
      throw new Error("locked");
    }
    return { release: f.release };
  });
  f.update.mockReset();
  f.update.mockImplementation(async (path: string, mutate: (store: unknown) => unknown) => {
    f.beforeWrite?.();
    return mutate(f.stores[path]);
  });
});

it("retires 20 entries with one index update and no global maintenance", async () => {
  const keys = Object.keys(f.stores.main);
  const results = await retireIdleSessions({}, keys);
  expect(results.every((result) => result.deleted)).toBe(true);
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.update.mock.calls[0][2]).toEqual({ skipMaintenance: true });
  expect(f.stores.main).toEqual({});
  expect(f.release).toHaveBeenCalledTimes(20);
  expect(f.remove).toHaveBeenCalledTimes(20);
  expect(f.prepare).toHaveBeenCalledTimes(20);
  expect(f.prepare.mock.invocationCallOrder[19]).toBeLessThan(f.update.mock.invocationCallOrder[0]);
  expect(f.update.mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
});

it("groups different indexes into one update each", async () => {
  f.stores.other["other:key"] = { sessionId: "other-id", updatedAt: 1 };
  expect(
    (await retireIdleSessions({}, ["key0", "key1", "other:key"])).every((r) => r.deleted),
  ).toBe(true);
  expect(f.update).toHaveBeenCalledTimes(2);
});

it("skips running, queued, child, ACP and locked sessions without writing the index", async () => {
  f.active.add("sid0");
  f.queued.add("key1");
  f.children.add("key2");
  f.stores.main.key3.acp = {};
  f.locked.add("/sid4.jsonl");
  const results = await retireIdleSessions({}, ["key0", "key1", "key2", "key3", "key4"]);
  expect(results.every((r) => !r.deleted && r.reason)).toBe(true);
  expect(f.update).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

it.each(["active", "replaced", "touched", "shared", "acp"])(
  "rechecks %s under the store lock",
  async (change) => {
    f.beforeWrite = () => {
      if (change === "active") {
        f.active.add("sid0");
      }
      if (change === "replaced") {
        f.stores.main.key0 = { sessionId: "new", updatedAt: 2 };
      }
      if (change === "touched") {
        f.stores.main.key0.updatedAt = 2;
      }
      if (change === "shared") {
        f.stores.main.unrelated = { sessionId: "sid0", updatedAt: 1 };
      }
      if (change === "acp") {
        f.stores.main.key0.acp = {};
      }
    };
    expect(await retireIdleSessions({}, ["key0"])).toEqual([
      { key: "key0", deleted: false, reason: "busy_or_changed" },
    ]);
    expect(f.stores.main).toHaveProperty("key0");
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  },
);

it("does not archive when the index write fails and releases all locks", async () => {
  f.update.mockRejectedValue(new Error("disk full"));
  expect(
    (await retireIdleSessions({}, ["key0", "key1"])).every((r) => r.reason === "store_error"),
  ).toBe(true);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(2);
});

it("keeps index and original when archiving fails", async () => {
  f.prepare.mockRejectedValue(new Error("disk full"));
  expect(await retireIdleSessions({}, ["key0"])).toEqual([
    { key: "key0", deleted: false, reason: "archive_failed" },
  ]);
  expect(f.stores.main).toHaveProperty("key0");
  expect(f.update).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});
it("does no index writes without an available archive directory", async () => {
  f.directory.mockRejectedValue(new Error("unconfigured"));
  expect(await retireIdleSessions({}, ["key0"])).toEqual([
    { key: "key0", deleted: false, reason: "archive_unavailable" },
  ]);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});
it("reports a retained original without losing its permanent archive", async () => {
  f.remove.mockResolvedValue(false);
  expect(await retireIdleSessions({}, ["key0"])).toMatchObject([
    { key: "key0", deleted: true, originalCleanupFailed: true, archiveDirectory: "/archive/sid0" },
  ]);
});
it("refuses concurrent sweeps while an archive is pending", async () => {
  let release!: () => void;
  f.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ directory: "/archive/sid0", files: [] });
      }),
  );
  const first = retireIdleSessions({}, ["key0"]);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  expect(f.update).not.toHaveBeenCalled();
  expect(await retireIdleSessions({}, ["key1"])).toEqual([
    { key: "key1", deleted: false, reason: "cleanup_busy" },
  ]);
  release();
  await first;
});
it("protects the main session, deduplicates keys and bounds request size", async () => {
  const results = await retireIdleSessions({}, ["main", "missing", "key0", "key0"]);
  expect(results).toHaveLength(3);
  expect(results[0]).toEqual({ key: "main", deleted: false, reason: "main_session" });
  expect(results[1]).toEqual({ key: "missing", deleted: false });
  expect(f.update).toHaveBeenCalledOnce();
  await expect(
    retireIdleSessions(
      {},
      Array.from({ length: 21 }, (_, i) => String(i)),
    ),
  ).rejects.toThrow("batch_size");
});

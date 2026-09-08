import { expect, it, vi } from "vitest";
import { retireIdleSession } from "./sessions-retire.js";
const retire = vi.hoisted(() =>
  vi.fn(async () => [{ key: "key", deleted: false, reason: "archive_unavailable" }]),
);
vi.mock("./sessions-retire-batch.js", () => ({ retireIdleSessions: retire }));
it("routes legacy idle-only retirement through the permanent archive guard", async () => {
  const cfg = { session: { archive: { directory: "/configured/archive" } } };
  const result = await retireIdleSession({
    cfg,
    key: "key",
    target: {} as never,
    deleteTranscript: true,
  });
  expect(result).toEqual({ ok: true, deleted: false, reason: "archive_unavailable" });
  expect(retire).toHaveBeenCalledWith(cfg, ["key"]);
});

import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";

afterEach(() => vi.restoreAllMocks());
it("bounds warmup metadata when a long-lived conversation creates many runtime segments", async () => {
  vi.stubEnv("OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS", "45000");
  const open = vi.spyOn(fs, "open").mockRejectedValue(new Error("test-only missing file"));
  trackSessionManagerAccess("first-runtime");
  for (let i = 0; i < 1024; i++) {
    trackSessionManagerAccess(`runtime-${i}`);
  }
  await prewarmSessionFile("runtime-1023");
  expect(open).not.toHaveBeenCalled();
  await prewarmSessionFile("first-runtime");
  expect(open).toHaveBeenCalledOnce();
});

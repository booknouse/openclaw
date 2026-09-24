import { describe, expect, it } from "vitest";
import {
  compactionBackgroundConcurrency,
  compactionModelPools,
  compactionModelReference,
} from "../agents/compaction-model-config.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("compaction model pools configuration", () => {
  const models = { primary: { model: "first/summary" }, secondary: { model: "second/summary" } };
  it.each([1000, 180000, 300000])("accepts bounded synchronous timeout %s", (timeoutMs) => {
    expect(AgentDefaultsSchema.parse({ compaction: { timeoutMs } })?.compaction?.timeoutMs).toBe(
      timeoutMs,
    );
  });
  it.each([0, 999, 300001, Infinity, 1.5, "180000"])(
    "rejects invalid synchronous timeout %s",
    (timeoutMs) => {
      expect(AgentDefaultsSchema.safeParse({ compaction: { timeoutMs } }).success).toBe(false);
    },
  );
  it("accepts two pools with background compaction and defaults to 4 plus 10", () => {
    const result = AgentDefaultsSchema.parse({
      compaction: { models, background: { enabled: true } },
    });
    expect(compactionModelPools(result?.compaction).map((p) => p.maxConcurrent)).toEqual([4, 10]);
    expect(compactionBackgroundConcurrency(result?.compaction)).toBe(14);
  });
  it("supports custom limits and ignores the legacy cap when pools are explicit", () => {
    const config = {
      model: "old/model",
      background: { maxConcurrent: 2 },
      models: {
        primary: { ...models.primary, maxConcurrent: 3 },
        secondary: { ...models.secondary, maxConcurrent: 7 },
      },
    };
    expect(AgentDefaultsSchema.safeParse({ compaction: config }).success).toBe(true);
    expect(compactionModelReference(config)).toBe("first/summary");
    expect(compactionBackgroundConcurrency(config)).toBe(10);
  });
  it("preserves legacy explicit limits and allows primary-only pools", () => {
    expect(
      compactionBackgroundConcurrency({ model: "old/model", background: { maxConcurrent: 2 } }),
    ).toBe(2);
    expect(compactionBackgroundConcurrency({ models: { primary: models.primary } })).toBe(4);
  });
  it.each([0, -1, 1.5, 129, "4"])("rejects invalid pool concurrency %s", (maxConcurrent) => {
    for (const role of ["primary", "secondary"]) {
      expect(
        AgentDefaultsSchema.safeParse({
          compaction: {
            models: { ...models, [role]: { model: role + "/summary", maxConcurrent } },
          },
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    { secondary: models.secondary },
    { primary: { model: " " } },
    { primary: models.primary, secondary: { model: "" } },
    { primary: models.primary, secondary: models.primary },
  ])("rejects incomplete or duplicate pools %j", (invalid) => {
    expect(AgentDefaultsSchema.safeParse({ compaction: { models: invalid } }).success).toBe(false);
  });
});

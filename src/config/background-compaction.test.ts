import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("background compaction configuration", () => {
  it("preserves existing configurations and disabled background defaults", () => {
    expect(AgentDefaultsSchema.safeParse({ compaction: {} }).success).toBe(true);
    expect(
      AgentDefaultsSchema.safeParse({ compaction: { background: { enabled: false } } }).success,
    ).toBe(true);
  });

  it.each([undefined, "", "  "])("requires an explicit summary model: %s", (model) => {
    const result = AgentDefaultsSchema.safeParse({
      compaction: { model, background: { enabled: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["compaction", "model"]);
    }
  });

  it("accepts a dedicated model independently of the conversation model", () => {
    expect(
      AgentDefaultsSchema.safeParse({
        model: { primary: "other/conversation" },
        compaction: {
          model: "ddww/gpt-5.6-luna",
          background: { enabled: true, triggerRatio: 0.7, maxOutputTokens: 4096, timeoutMs: 60000 },
        },
      }).success,
    ).toBe(true);
  });

  it.each([{ triggerRatio: 0.99 }, { timeoutMs: 0 }, { maxConcurrent: 0 }, { maxOutputTokens: 0 }])(
    "rejects unsafe bounds: %j",
    (background) => {
      expect(
        AgentDefaultsSchema.safeParse({
          compaction: { model: "ddww/gpt-5.6-luna", background: { enabled: true, ...background } },
        }).success,
      ).toBe(false);
    },
  );
});

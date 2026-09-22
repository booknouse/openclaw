import { describe, expect, it } from "vitest";
import { replacePatternBounded } from "./redact-bounded.js";

describe("bounded redaction without unnecessary text copies", () => {
  it("preserves unchanged multi-chunk text", () => {
    const text = "测量日志🙂 safe text ".repeat(10000);
    expect(replacePatternBounded(text, /SECRET/g, () => "***")).toBe(text);
  });

  it.each([
    "plain text",
    "SECRET in first chunk",
    "abcdefghSECRET middle",
    "abcdefghijklmnopSECRET",
    "SECRETxxSECRETxxSECRET",
  ])("keeps the existing per-chunk replacement behavior for %j", (text) => {
    let expected = "";
    for (let i = 0; i < text.length; i += 8) {
      expected += text.slice(i, i + 8).replace(/SECRET/g, "***");
    }
    expect(
      replacePatternBounded(text, /SECRET/g, () => "***", { chunkThreshold: 1, chunkSize: 8 }),
    ).toBe(expected);
  });

  it("preserves unchanged prefixes and suffixes around a late match", () => {
    const text = "abcdefgh".repeat(100) + "SECRETxx" + "abcdefgh".repeat(100);
    expect(
      replacePatternBounded(text, /SECRET/g, () => "***", { chunkThreshold: 1, chunkSize: 8 }),
    ).toBe(text.replace(/SECRET/g, "***"));
  });

  it("supports capture groups and replacement callbacks", () => {
    expect(
      replacePatternBounded(
        "abcdefghKEY=1234abcdefghKEY=5678",
        /KEY=(\d+)/g,
        (_match, digits: string) => `KEY=${digits[0]}***`,
        { chunkThreshold: 1, chunkSize: 8 },
      ),
    ).toBe("abcdefghKEY=1***abcdefghKEY=5***");
  });
});

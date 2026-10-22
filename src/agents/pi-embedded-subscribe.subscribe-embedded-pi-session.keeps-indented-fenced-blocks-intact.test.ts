import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  extractTextPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps indented fenced blocks intact", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 5,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(onBlockReply.mock.calls[1][0].text).toBe("  ```js\n  const x = 1;\n  ```");
  });
  it("accepts longer fence markers for close", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 30,
      },
    });

    const text = "Intro\n\n````md\nline1\nline2\n````\n\nOutro";

    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();

    const payloadTexts = extractTextPayloads(onBlockReply.mock.calls);
    expect(payloadTexts.length).toBeGreaterThan(0);
    const combined = payloadTexts.join(" ").replace(/\s+/g, " ").trim();
    expect(combined).toContain("````md");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
    expect(combined).toContain("````");
    expect(combined).toContain("Intro");
    expect(combined).toContain("Outro");
  });
});

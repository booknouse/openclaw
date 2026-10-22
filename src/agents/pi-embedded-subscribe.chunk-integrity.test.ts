import type { AssistantMessage } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

function message(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
}

it.each(
  (["text_end", "message_end"] as const).flatMap((boundary) =>
    [24, 30, 40, 64].flatMap((maxChars) =>
      [1, 17, 1000].flatMap((deltaSize) =>
        [80, 120].map((bodySize) => ({ boundary, maxChars, deltaSize, bodySize })),
      ),
    ),
  ),
)(
  "keeps every repeated code character: $boundary max=$maxChars delta=$deltaSize body=$bodySize",
  async ({ boundary, maxChars, deltaSize, bodySize }) => {
    const onBlockReply = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "chunk-integrity",
      onBlockReply,
      blockReplyBreak: boundary,
      blockReplyChunking: { minChars: 10, maxChars, breakPreference: "paragraph" },
    });
    const body = "x".repeat(bodySize);
    const text = "```json\n" + body + "\n```";
    try {
      h.emit({ type: "message_start", message: message("") });
      for (let i = 0; i < text.length; i += deltaSize) {
        emitAssistantTextDelta({ emit: h.emit, delta: text.slice(i, i + deltaSize) });
      }
      emitAssistantTextEnd({ emit: h.emit, content: text });
      h.emit({ type: "message_end", message: message(text) });
      await Promise.resolve();
      const chunks = onBlockReply.mock.calls.map(([p]) => p.text as string);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.startsWith("```json\n")).toBe(true);
        expect(chunk.endsWith("\n```"), JSON.stringify(chunks)).toBe(true);
      }
      const restored = chunks
        .map((s) => s.replace(/^```json\n/, "").replace(/\n```$/, ""))
        .join("");
      expect(restored).toBe(body);
      expect(h.subscription.assistantTexts).toEqual(chunks);

      // These are replays of the completed source, not new character ranges.
      emitAssistantTextEnd({ emit: h.emit, content: text });
      h.emit({ type: "message_end", message: message(text + "\n") });
      emitAssistantTextEnd({ emit: h.emit });
      await Promise.resolve();
      expect(onBlockReply.mock.calls.map(([p]) => p.text)).toEqual(chunks);
      expect(h.subscription.assistantTexts).toEqual(chunks);

      // The same text in a new assistant message is legitimate, not a replay.
      h.emit({ type: "message_start", message: message("") });
      emitAssistantTextDelta({ emit: h.emit, delta: text });
      emitAssistantTextEnd({ emit: h.emit, content: text });
      h.emit({ type: "message_end", message: message(text) });
      await Promise.resolve();
      const newChunks = onBlockReply.mock.calls.slice(chunks.length).map(([p]) => p.text as string);
      expect(newChunks.map((s) => s.replace(/^```json\n/, "").replace(/\n```$/, "")).join("")).toBe(
        body,
      );
    } finally {
      h.subscription.unsubscribe();
    }
  },
);

it("retains equal adjacent plain-text ranges produced by the chunker", async () => {
  const chunking = { minChars: 5, maxChars: 20, breakPreference: "paragraph" as const };
  const text = "same paragraph\n\nsame paragraph\n\nsame paragraph\n\nlast paragraph";
  const direct: string[] = [];
  const chunker = new EmbeddedBlockChunker(chunking);
  chunker.append(text);
  chunker.drain({ force: true, emit: (chunk) => direct.push(chunk.trimEnd()) });
  const onBlockReply = vi.fn();
  const h = createSubscribedSessionHarness({
    runId: "repeated-paragraphs",
    onBlockReply,
    blockReplyBreak: "message_end",
    blockReplyChunking: chunking,
  });
  try {
    h.emit({ type: "message_start", message: message("") });
    emitAssistantTextDelta({ emit: h.emit, delta: text });
    h.emit({ type: "message_end", message: message(text) });
    await Promise.resolve();
    expect(onBlockReply.mock.calls.map(([p]) => p.text)).toEqual(direct);
  } finally {
    h.subscription.unsubscribe();
  }
});

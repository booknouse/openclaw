import assert from "node:assert/strict";
import { streamOpenAIResponses } from "@mariozechner/pi-ai";
import { test } from "vitest";

const model = {
  id: "test-model",
  name: "test-model",
  api: "openai-responses" as const,
  provider: "test",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text" as const],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function message(id: string, text: string, phase = "final_answer") {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function events(finalText: string, snapshot: unknown[] | undefined) {
  return [
    { type: "response.output_item.added", output_index: 0, item: message("msg_a", "") },
    {
      type: "response.content_part.added",
      item_id: "msg_a",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_a",
      output_index: 0,
      content_index: 0,
      delta: "answer",
    },
    { type: "response.output_item.done", output_index: 0, item: message("msg_a", finalText) },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: snapshot,
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ];
}

async function replay(input: unknown[]) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(input.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  try {
    const stream = streamOpenAIResponses(model, { messages: [] }, { apiKey: "test-key" });
    return await stream.result();
  } finally {
    globalThis.fetch = original;
  }
}

test("completed snapshot restores text erased by an empty item.done", async () => {
  const result = await replay(events("", [message("msg_a", "answer")]));
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.content.map((b) => (b.type === "text" ? b.text : "")),
    ["answer"],
  );
  assert.equal(result.usage.output, 3);
});

test("explicit final empty text does not resurrect withdrawn deltas", async () => {
  const result = await replay(events("answer", [message("msg_a", "")]));
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.content.map((b) => (b.type === "text" ? b.text : "")),
    [""],
  );
});

test("missing final snapshot after cleared text is a protocol error", async () => {
  const result = await replay(events("", undefined));
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /cleared text/);
});

test("normal snapshots do not duplicate text", async () => {
  const result = await replay(events("answer", [message("msg_a", "answer")]));
  assert.equal(result.content.length, 1);
  assert.equal(result.stopReason, "stop");
});

test("completed-only messages retain separate phases and ordering", async () => {
  const result = await replay(
    events("answer", [message("msg_a", "answer"), message("msg_b", "next", "commentary")]),
  );
  assert.deepEqual(
    result.content.map((b) => (b.type === "text" ? b.text : "")),
    ["answer", "next"],
  );
  const last = result.content[1];
  assert.equal(last.type === "text" && JSON.parse(last.textSignature ?? "{}").phase, "commentary");
});

test("authoritative refusal replaces prior text", async () => {
  const item = { ...message("msg_a", ""), content: [{ type: "refusal", refusal: "declined" }] };
  const result = await replay(events("answer", [item]));
  assert.deepEqual(
    result.content.map((b) => (b.type === "text" ? b.text : "")),
    ["declined"],
  );
});

test("failed responses do not restore text from a completed snapshot", async () => {
  const input = events("", []);
  input.pop();
  const result = await replay([
    ...input,
    { type: "response.failed", response: { error: { code: "failed", message: "failed" } } },
  ]);
  assert.equal(result.stopReason, "error");
});

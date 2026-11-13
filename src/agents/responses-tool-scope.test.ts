import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  constrainResponsesTools,
  wrapStreamWithResponsesToolScope,
} from "./responses-tool-scope.js";
const fn = (name: string) => ({ type: "function", name });
const names = new Set(["codex_image2_generate", "read"]);
const payload = { tools: [fn("codex_image2_generate"), fn("read")] };
afterEach(() => vi.unstubAllGlobals());
it("limits auto choice to declared authorized functions, excluding injected tools", () => {
  expect(
    constrainResponsesTools(
      { tools: [...payload.tools, fn("forbidden"), { type: "image_generation" }] },
      names,
    ),
  ).toMatchObject({
    tool_choice: { type: "allowed_tools", mode: "auto", tools: payload.tools },
  });
});
it("keeps no-tool turns text-only", () => {
  expect(constrainResponsesTools({ tools: [] }, new Set())).toEqual({
    tools: [],
    tool_choice: "none",
  });
});
it.each(["none", fn("read"), { type: "allowed_tools", mode: "required", tools: [fn("read")] }])(
  "preserves stricter selection %j",
  (choice) => {
    expect(constrainResponsesTools({ ...payload, tool_choice: choice }, names)).toMatchObject({
      tool_choice: choice,
    });
  },
);
it.each([
  fn("forbidden"),
  { type: "image_generation" },
  { type: "allowed_tools", mode: "auto", tools: [fn("forbidden")] },
])("rejects unauthorized selection %j", (choice) => {
  expect(() => constrainResponsesTools({ ...payload, tool_choice: choice }, names)).toThrow(
    /authorized/,
  );
});
it("does not widen required or invent tools", () => {
  expect(constrainResponsesTools({ ...payload, tool_choice: "required" }, names)).toMatchObject({
    tool_choice: { mode: "required" },
  });
  expect(() => constrainResponsesTools({ tool_choice: "required" }, new Set())).toThrow(
    /No authorized/,
  );
});
it("applies the scope after async payload hooks on the actual SDK request", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const model: Model<"openai-responses"> = {
    id: "test",
    name: "test",
    api: "openai-responses",
    provider: "ddww",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const wrapped = wrapStreamWithResponsesToolScope(streamSimple);
  const result = await (
    await wrapped(
      model,
      { messages: [] },
      {
        apiKey: "test",
        onPayload: async (p) => ({
          ...(p as object),
          marker: "preserved",
          tools: [fn("injected")],
        }),
      },
    )
  ).result();
  expect(result.stopReason).toBe("stop");
  expect(requests[0]).toMatchObject({ marker: "preserved", tool_choice: "none" });
  await (
    await wrapped({ ...model, provider: "other" }, { messages: [] }, { apiKey: "test" })
  ).result();
  expect(requests[1]).not.toHaveProperty("tool_choice");
});

it("recomputes the actual SDK scope for non-cost, planner and worker calls", async () => {
  const requests: Array<{ tool_choice: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const model: Model<"openai-responses"> = {
    id: "test",
    name: "test",
    api: "openai-responses",
    provider: "ddww",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const wrapped = wrapStreamWithResponsesToolScope(streamSimple);
  for (const toolNames of [
    ["codex_image2_generate", "read", "sessions_spawn"],
    ["read", "sessions_spawn"],
    ["codex_image2_generate", "read"],
    [],
  ]) {
    const tools = toolNames.map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
    }));
    const result = await (
      await wrapped(model, { messages: [], tools }, { apiKey: "test" })
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(requests.at(-1)?.tool_choice).toEqual(
      toolNames.length ? { type: "allowed_tools", mode: "auto", tools: toolNames.map(fn) } : "none",
    );
  }
});

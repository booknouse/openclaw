import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRequestHeaders,
  withAgentUserAgent,
  wrapStreamWithAgentUserAgent,
} from "./model-user-agent.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://model.test/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: "user" as const, content: "say OK", timestamp: 1 }] };
afterEach(() => vi.unstubAllGlobals());

function interceptRequests() {
  const requests: Array<{ userAgent: string | null; body: string; custom: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(typeof init.body).toBe("string");
      const h = new Headers(init.headers);
      requests.push({
        userAgent: h.get("user-agent"),
        body: typeof init.body === "string" ? init.body : "",
        custom: h.get("x-custom"),
      });
      await Promise.resolve();
      const chunk = {
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: model.id,
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  return requests;
}

describe("model request agent attribution", () => {
  it("appends to the actual SDK User-Agent and isolates concurrent agents", async () => {
    const requests = interceptRequests();
    const options = Object.freeze({
      apiKey: "test-key",
      headers: Object.freeze({ "X-Custom": "kept" }),
    });
    await streamSimple(model, context, options).result();
    const original = requests[0].userAgent;
    expect(original).toMatch(/^OpenAI\/JS \d+\.\d+\.\d+/);
    await Promise.all(
      ["xuebing", "wusy", "pd_data_analyst"].map(async (agent) => {
        const stream = wrapStreamWithAgentUserAgent(streamSimple, agent)(model, context, options);
        const result = await (await stream).result();
        expect(result.stopReason).toBe("stop");
      }),
    );
    expect(
      requests
        .slice(1)
        .map((r) => r.userAgent)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(
      ["xuebing", "wusy", "pd_data_analyst"]
        .map((agent) => `${original} OpenClaw-Agent/${agent}`)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    );
    expect(requests.every((r) => r.custom === "kept")).toBe(true);
    expect(requests.every((r) => !r.body.includes("OpenClaw-Agent"))).toBe(true);
    expect(options.headers).toEqual({ "X-Custom": "kept" });
    expect(model.headers).toBeUndefined();
  });

  it("preserves configured and per-request user agents with case-insensitive overrides", async () => {
    const requests = interceptRequests();
    const configured = {
      ...model,
      headers: Object.freeze({ "user-agent": "custom-sdk/9", "X-Custom": "kept" }),
    };
    const tagged = withAgentUserAgent(configured, "first");
    await streamSimple(tagged, context, { apiKey: "test-key" }).result();
    const wrapped = wrapStreamWithAgentUserAgent(streamSimple, "second");
    await (
      await wrapped(configured, context, {
        apiKey: "test-key",
        headers: { "USER-AGENT": "request-sdk/2" },
      })
    ).result();
    expect(requests.map((r) => r.userAgent)).toEqual([
      "custom-sdk/9 OpenClaw-Agent/first",
      "request-sdk/2 OpenClaw-Agent/second",
    ]);
    expect(configured.headers["user-agent"]).toBe("custom-sdk/9");
  });

  it("sends attribution through the actual Responses HTTP SDK", async () => {
    let actual: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        actual = new Headers(init.headers).get("user-agent");
        return new Response(
          JSON.stringify({
            error: { message: "intentional test stop", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const responses = withAgentUserAgent(
      { ...model, api: "openai-responses" as const, compat: undefined },
      "wusy",
    );
    const result = await streamSimple(responses, context, { apiKey: "test-key" }).result();
    expect(result.stopReason).toBe("error");
    expect(actual).toMatch(/^OpenAI\/JS \d+\.\d+\.\d+ OpenClaw-Agent\/wusy$/);
  });

  it("replaces old attribution once, encodes unsafe characters, and keeps model metadata", () => {
    const first = withAgentUserAgent(model, "old");
    const next = withAgentUserAgent(first, "new\r\nheader:用户");
    expect(next.headers?.["User-Agent"]).toContain("OpenClaw-Agent/new%0D%0Aheader%3A");
    expect(next.headers?.["User-Agent"]).not.toContain("\r");
    expect(next.headers?.["User-Agent"]?.match(/OpenClaw-Agent\//g)).toHaveLength(1);
    expect(first.headers?.["User-Agent"]).toContain("/old");
    expect(next.contextWindow).toBe(model.contextWindow);
    expect(withAgentUserAgent(model, " ")).toBe(model);
  });

  it("tags Responses HTTP options and leaves other SDK protocols untouched", () => {
    const inner = vi.fn() as unknown as StreamFn;
    const wrapped = wrapStreamWithAgentUserAgent(inner, "wusy");
    void wrapped({ ...model, api: "openai-responses" }, context, {});
    expect(vi.mocked(inner).mock.calls[0][2]?.headers?.["User-Agent"]).toContain(
      " OpenClaw-Agent/wusy",
    );
    const other = { ...model, api: "anthropic-messages" as const, compat: undefined };
    const options = { apiKey: "test-key" };
    void wrapped(other, context, options);
    expect(vi.mocked(inner).mock.calls[1][2]).toBe(options);
    expect(withAgentUserAgent(other, "wusy")).toBe(other);
    expect(agentRequestHeaders(model, "wusy")["User-Agent"]).toContain("/wusy");
  });
});

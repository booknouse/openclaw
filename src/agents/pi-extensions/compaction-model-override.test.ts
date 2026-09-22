import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as compaction from "../compaction.js";
import { getNativeCompactionFailure } from "../native-compaction-state.js";
import { buildEmbeddedExtensionFactories } from "../pi-embedded-runner/extensions.js";
import {
  setCompactionSafeguardRuntime,
  getCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import safeguard from "./compaction-safeguard.js";

vi.mock("../compaction.js", async (original) => ({
  ...(await original<typeof compaction>()),
  summarizeInStages: vi.fn(),
}));
const summarize = vi.mocked(compaction.summarizeInStages);
const dialogue = {
  id: "dialogue",
  provider: "primary",
  api: "openai-completions",
  contextWindow: 270000,
  maxTokens: 4096,
} as Model<Api>;
const dedicated = {
  ...dialogue,
  provider: "summary-provider",
  id: "summary",
  contextWindow: 100000,
};
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
function fixture() {
  let handler!: Handler;
  safeguard({
    on: (_name: string, fn: Handler) => {
      handler = fn;
    },
  } as unknown as ExtensionAPI);
  const sessionManager = {} as ExtensionContext["sessionManager"];
  const ctx = {
    model: dialogue,
    sessionManager,
    modelRegistry: { getApiKey: vi.fn().mockResolvedValue("dialogue-key") },
  };
  const event = {
    signal: new AbortController().signal,
    preparation: {
      messagesToSummarize: [{ role: "user", content: "Preserve the current task", timestamp: 1 }],
      turnPrefixMessages: [],
      firstKeptEntryId: "kept",
      tokensBefore: 1000,
      settings: { reserveTokens: 20000, keepRecentTokens: 8000 },
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    },
  };
  return { handler, sessionManager, ctx, event };
}
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("automatic compaction model override", () => {
  it("uses the dedicated model and credentials without mutating the dialogue model", async () => {
    const f = fixture();
    setCompactionSafeguardRuntime(f.sessionManager, {
      recentTurnsPreserve: 0,
      contextWindowTokens: 270000,
      resolveModel: async () => ({ model: dedicated, apiKey: "summary-key" }),
    });
    summarize.mockResolvedValue("summary");
    await f.handler(f.event, f.ctx);
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ model: dedicated, apiKey: "summary-key", contextWindow: 100000 }),
    );
    expect(f.ctx.model).toBe(dialogue);
    expect(f.ctx.modelRegistry.getApiKey).not.toHaveBeenCalled();
  });

  it("cancels without silently falling back to dialogue credentials when the override fails", async () => {
    const f = fixture();
    setCompactionSafeguardRuntime(f.sessionManager, {
      resolveModel: async () => {
        throw new Error("unavailable");
      },
    });
    await expect(f.handler(f.event, f.ctx)).resolves.toEqual({ cancel: true });
    expect(summarize).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.getApiKey).not.toHaveBeenCalled();
  });

  it("enforces the whole-hook deadline and never commits an unfinished summary", async () => {
    vi.useFakeTimers();
    const f = fixture();
    setCompactionSafeguardRuntime(f.sessionManager, { recentTurnsPreserve: 0 });
    summarize.mockImplementation(() => new Promise(() => {}));
    const task = f.handler(f.event, f.ctx);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(task).resolves.toEqual({ cancel: true });
  });

  it("installs the override for automatic compaction even when mode is default", () => {
    const f = fixture();
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: { compaction: { mode: "default", model: "summary-provider/summary" } },
        },
      },
      sessionManager: f.sessionManager as Parameters<
        typeof buildEmbeddedExtensionFactories
      >[0]["sessionManager"],
      provider: "primary",
      modelId: "dialogue",
      model: dialogue,
    });
    expect(factories.length).toBeGreaterThan(0);
    expect(getCompactionSafeguardRuntime(f.sessionManager)?.resolveModel).toBeTypeOf("function");
  });
  it("installs pooled routing for manual compaction even after its primary model was resolved", () => {
    const f = fixture();
    buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              models: {
                primary: { model: "primary/summary" },
                secondary: { model: "secondary/summary" },
              },
            },
          },
        },
      },
      sessionManager: f.sessionManager as Parameters<
        typeof buildEmbeddedExtensionFactories
      >[0]["sessionManager"],
      provider: "primary",
      modelId: "summary",
      model: dialogue,
      compactionModelResolved: true,
      compactionProvider: "dialogue",
    });
    expect(getCompactionSafeguardRuntime(f.sessionManager)?.resolveModel).toBeTypeOf("function");
  });
  it("propagates caller cancellation into the actual summarizer before the deadline", async () => {
    const f = fixture();
    const controller = new AbortController();
    setCompactionSafeguardRuntime(f.sessionManager, {
      recentTurnsPreserve: 0,
      abortSignal: controller.signal,
    });
    let providerSignal: AbortSignal | undefined;
    summarize.mockImplementation(async (params) => {
      providerSignal = params.signal;
      return await new Promise<string>((_, reject) =>
        params.signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    });
    const task = f.handler(f.event, f.ctx);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    await expect(task).resolves.toEqual({ cancel: true });
    expect(providerSignal?.aborted).toBe(true);
  });
});

it("combines a fitting split turn while preserving the native cut and protected constraints", async () => {
  const f = fixture();
  const event = {
    ...f.event,
    preparation: {
      ...f.event.preparation,
      isSplitTurn: true,
      previousSummary: "Earlier choice: TASK-123",
      turnPrefixMessages: [
        { role: "user", content: "必须保留 /workspace/circuit/check.py", timestamp: 2 },
      ],
    },
  };
  setCompactionSafeguardRuntime(f.sessionManager, { conciseSummary: true, recentTurnsPreserve: 0 });
  summarize.mockResolvedValue("concise summary");
  const result = await f.handler(event, f.ctx);
  expect(summarize).toHaveBeenCalledOnce();
  expect(summarize.mock.calls[0][0].messages).toHaveLength(2);
  expect(summarize.mock.calls[0][0].previousSummary).toBe("Earlier choice: TASK-123");
  expect(result).toMatchObject({
    compaction: {
      firstKeptEntryId: "kept",
      tokensBefore: 1000,
      summary: expect.stringContaining("必须保留 /workspace/circuit/check.py"),
    },
  });
});

it("records a native failure for recovery and clears it after success", async () => {
  const f = fixture();
  const file = "/test/native-failure-status.jsonl";
  Object.assign(f.sessionManager, { getSessionFile: () => file });
  setCompactionSafeguardRuntime(f.sessionManager, { conciseSummary: true, recentTurnsPreserve: 0 });
  summarize.mockRejectedValueOnce(new Error("provider failed"));
  await expect(f.handler(f.event, f.ctx)).resolves.toEqual({ cancel: true });
  expect(getNativeCompactionFailure(file)).toBeDefined();
  summarize.mockResolvedValue("recovered summary");
  await f.handler(f.event, f.ctx);
  expect(getNativeCompactionFailure(file)).toBeUndefined();
});

it("does not classify user cancellation as a native compaction failure", async () => {
  const f = fixture();
  const file = "/test/native-user-abort.jsonl";
  Object.assign(f.sessionManager, { getSessionFile: () => file });
  const controller = new AbortController();
  setCompactionSafeguardRuntime(f.sessionManager, {
    conciseSummary: true,
    recentTurnsPreserve: 0,
    abortSignal: controller.signal,
  });
  summarize.mockImplementation(async () => {
    controller.abort();
    throw new DOMException("cancelled", "AbortError");
  });
  await expect(f.handler(f.event, f.ctx)).resolves.toEqual({ cancel: true });
  expect(getNativeCompactionFailure(file)).toBeUndefined();
});

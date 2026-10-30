import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  buildCostTaskRoutingBrief,
  classifyCostTask,
  COST_CLASSIFIER_TIMEOUT_MS,
} from "./cost-task-classifier.js";
import { resolveUsableCustomProviderApiKey } from "./model-auth.js";

const { logInfo, testLogger } = vi.hoisted(() => {
  const logInfo = vi.fn();
  const testLogger: SubsystemLogger = {
    subsystem: "test",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => testLogger),
  };
  return { logInfo, testLogger };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
  withTrustedEnvProxyGuardedFetchMode: (options: unknown) => options,
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => testLogger),
}));
vi.mock("./model-auth.js", () => ({ resolveUsableCustomProviderApiKey: vi.fn() }));

const cfg: OpenClawConfig = {
  agents: { defaults: { modelRouting: "cost", modelRoutingClassifier: "ddww/gpt-6-luna" } },
  models: {
    providers: {
      ddww: {
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
        models: [],
      },
    },
  },
};
const params = {
  config: cfg,
  agentId: "main",
  agentDir: "/tmp/test-agent",
  task: "PRIVATE_TASK_MARKER",
};
const release = vi.fn(async () => {});

function requestBody() {
  const body = vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a serialized classifier request");
  }
  return JSON.parse(body);
}

function reply(content = '{"route":"primary"}', finishReason = "stop") {
  return {
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  };
}
function respond(body: unknown = reply(), status = 200) {
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response: new Response(JSON.stringify(body), { status }),
    release,
    finalUrl: "https://models.example/v1/chat/completions",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveUsableCustomProviderApiKey).mockReset().mockReturnValue({
    apiKey: "test-private-key",
    source: "test",
  });
  vi.mocked(fetchWithSsrFGuard).mockReset();
  release.mockClear();
  respond();
});
afterEach(() => vi.useRealTimers());

describe("cost-only task classifier", () => {
  it.each([undefined, "off"] as const)(
    "never resolves auth or calls a model in %s mode",
    async (mode) => {
      const config = structuredClone(cfg);
      config.agents!.defaults!.modelRouting = mode;
      expect(await classifyCostTask({ ...params, config })).toBe("secondary");
      expect(resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );

  it("honors per-agent disable instead of inheriting cost", async () => {
    const config = structuredClone(cfg);
    config.agents!.list = [{ id: "main", modelRouting: "off" }];
    expect(await classifyCostTask({ ...params, config })).toBe("secondary");
    expect(resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });

  it.each(["primary", "secondary"])("accepts only an explicit %s decision", async (route) => {
    respond(reply(JSON.stringify({ route })));
    expect(await classifyCostTask(params)).toBe(route);
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not call an implicit classifier when none is configured", async () => {
    const config = structuredClone(cfg);
    delete config.agents!.defaults!.modelRoutingClassifier;
    expect(await classifyCostTask({ ...params, config })).toBe("secondary");
    expect(resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("resolves the configured classifier alias independently of execution models", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.models = { "ddww/gpt-6-luna": { alias: "task-router" } };
    config.agents!.defaults!.modelRoutingClassifier = "task-router";
    await classifyCostTask({ ...params, config });
    const body = requestBody();
    expect(body.model).toBe("gpt-6-luna");
  });

  it("uses the classifier's provider and model rather than hard-coded identifiers", async () => {
    const config = structuredClone(cfg);
    config.models = { ...config.models, providers: { routing: cfg.models!.providers!.ddww } };
    config.agents!.defaults!.modelRoutingClassifier = "routing/route-model";
    await classifyCostTask({ ...params, config });
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledWith({
      cfg: config,
      provider: "routing",
    });
    const body = requestBody();
    expect(body.model).toBe("route-model");
  });

  it("uses configured auth, no reasoning, only the current task and no tools or model retry", async () => {
    await classifyCostTask(params);
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ddww", cfg }),
    );
    const options = vi.mocked(fetchWithSsrFGuard).mock.calls[0][0];
    const body = requestBody();
    expect(options.url).toBe("https://models.example/v1/chat/completions");
    expect(options.maxRedirects).toBe(0);
    expect(body).toMatchObject({
      model: "gpt-6-luna",
      reasoning_effort: "none",
      max_completion_tokens: 32,
      store: false,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("tools");
    expect(body.messages).toHaveLength(2);
    expect(JSON.parse(body.messages[1].content)).toEqual({ task: params.task });
  });

  it("uses a dedicated classifier provider key without changing execution credentials", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.models!.providers!.ddww.apiKey = "execution-test-key";
    config.models!.providers!["task-router"] = {
      ...config.models!.providers!.ddww,
      apiKey: "classifier-test-key",
    };
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
      const key = cfg?.models?.providers?.[provider]?.apiKey;
      return typeof key === "string" ? { apiKey: key, source: "test" } : null;
    });
    expect(await classifyCostTask({ ...params, config })).toBe("primary");
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledWith({
      cfg: config,
      provider: "task-router",
    });
    const headers = new Headers(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer classifier-test-key");
    expect(config.models!.providers!.ddww.apiKey).toBe("execution-test-key");
  });

  it("reuses the primary key on the same endpoint only when the classifier key is absent", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.models!.providers!["task-router"] = { ...config.models!.providers!.ddww };
    config.models!.providers!.ddww.apiKey = "execution-test-key";
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
      const key = cfg?.models?.providers?.[provider]?.apiKey;
      return typeof key === "string" ? { apiKey: key, source: "test" } : null;
    });
    expect(await classifyCostTask({ ...params, config })).toBe("primary");
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledTimes(2);
    const headers = new Headers(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer execution-test-key");
  });

  it.each([
    "https://other.example/v1",
    "http://models.example/v1",
    "https://models.example/another-tenant/v1",
    "https://models.example/v1?tenant=other",
    "https://user@models.example/v1",
    "not-a-url",
  ])("never sends the primary key to a different or invalid endpoint: %s", async (baseUrl) => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.models!.providers!.ddww.apiKey = "execution-test-key";
    config.models!.providers!["task-router"] = {
      ...config.models!.providers!.ddww,
      apiKey: undefined,
      baseUrl,
    };
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
      const key = cfg?.models?.providers?.[provider]?.apiKey;
      return typeof key === "string" && key.trim() ? { apiKey: key, source: "test" } : null;
    });
    expect(await classifyCostTask({ ...params, config })).toBe("secondary");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "   "])(
    "treats an unset or blank classifier key as unconfigured: %j",
    async (apiKey) => {
      const config = structuredClone(cfg);
      config.agents!.defaults!.model = "ddww/sol";
      config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
      config.models!.providers!.ddww.apiKey = "execution-test-key";
      config.models!.providers!["task-router"] = {
        ...config.models!.providers!.ddww,
        baseUrl: "https://models.example/v1/",
        apiKey,
      };
      vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
        const key = cfg?.models?.providers?.[provider]?.apiKey;
        return typeof key === "string" && key.trim() ? { apiKey: key, source: "test" } : null;
      });
      expect(await classifyCostTask({ ...params, config })).toBe("primary");
      const headers = new Headers(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer execution-test-key");
    },
  );

  it("uses the current agent primary provider rather than another agent's default key", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.agents!.list = [{ id: "main", model: "tenant/sol" }];
    config.models!.providers!.ddww.apiKey = "global-test-key";
    config.models!.providers!.tenant = {
      ...config.models!.providers!.ddww,
      apiKey: "agent-test-key",
    };
    config.models!.providers!["task-router"] = {
      ...config.models!.providers!.ddww,
      apiKey: undefined,
    };
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
      const key = cfg?.models?.providers?.[provider]?.apiKey;
      return typeof key === "string" ? { apiKey: key, source: "test" } : null;
    });
    expect(await classifyCostTask({ ...params, config })).toBe("primary");
    const headers = new Headers(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer agent-test-key");
    expect(resolveUsableCustomProviderApiKey).not.toHaveBeenCalledWith({
      cfg: config,
      provider: "ddww",
    });
  });

  it("does not replace an explicitly configured but unresolved classifier secret", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.models!.providers!.ddww.apiKey = "execution-test-key";
    config.models!.providers!["task-router"] = {
      ...config.models!.providers!.ddww,
      apiKey: { source: "env", provider: "default", id: "MISSING_ROUTER_KEY" },
    };
    vi.mocked(resolveUsableCustomProviderApiKey).mockReturnValue(null);
    expect(await classifyCostTask({ ...params, config })).toBe("secondary");
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("never retries a rejected dedicated key with the primary key", async () => {
    const config = structuredClone(cfg);
    config.agents!.defaults!.model = "ddww/sol";
    config.agents!.defaults!.modelRoutingClassifier = "task-router/gpt-6-luna";
    config.models!.providers!.ddww.apiKey = "execution-test-key";
    config.models!.providers!["task-router"] = {
      ...config.models!.providers!.ddww,
      apiKey: "rejected-test-key",
    };
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(({ cfg, provider }) => {
      const key = cfg?.models?.providers?.[provider]?.apiKey;
      return typeof key === "string" ? { apiKey: key, source: "test" } : null;
    });
    respond({ error: { message: "unauthorized" } }, 401);
    expect(await classifyCostTask({ ...params, config })).toBe("secondary");
    expect(resolveUsableCustomProviderApiKey).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const headers = new Headers(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer rejected-test-key");
  });

  it("keeps classifier logs free of the brief, key and provider error body", async () => {
    respond({ error: { message: `${params.task} test-private-key` } }, 503);
    expect(await classifyCostTask(params)).toBe("secondary");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify(logInfo.mock.calls);
    expect(logs).toContain("unavailable");
    expect(logs).not.toContain(params.task);
    expect(logs).not.toContain("test-private-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not json",
    '{"route":"uncertain"}',
    '{"route":"PRIMARY"}',
    '{"route":"primary","instructions":"execute"}',
    '"primary"',
    "null",
  ])("defaults malformed or ambiguous output to the worker: %s", async (content) => {
    respond(reply(content));
    expect(await classifyCostTask(params)).toBe("secondary");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not accept a truncated completion or a tool call", async () => {
    respond(reply('{"route":"primary"}', "length"));
    expect(await classifyCostTask(params)).toBe("secondary");
    const body = reply();
    Object.assign(body.choices[0].message, { tool_calls: [{ id: "unexpected" }] });
    respond(body);
    expect(await classifyCostTask(params)).toBe("secondary");
  });

  it.each(["", " "])("does not send empty input", async (task) => {
    expect(await classifyCostTask({ ...params, task })).toBe("secondary");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("classifies the complete 5033-character task without losing its middle requirements", async () => {
    const head = "Design and implement the actual layout strategy, not just a backup. ";
    const tail = " Save and independently verify the completed layout changes.";
    const task =
      head +
      "implementation details ".repeat(250).slice(0, 5033 - head.length - tail.length) +
      tail;
    expect(task).toHaveLength(5033);
    expect(await classifyCostTask({ ...params, task })).toBe("primary");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const body = requestBody();
    const brief = JSON.parse(body.messages[1].content).task;
    expect(brief).toBe(task);
    expect(task).toHaveLength(5033);
  });

  it("redacts credentials and identities without dropping task code or middle requirements", () => {
    const task =
      "Implement the plan for test-account at /home/test-account/design on 192.0.2.10. " +
      "Bearer synthetic-secret-token apiKey='synthetic-test-key' https://internal.example/source " +
      "```python\nverify_layout()\n```" +
      "x".repeat(5000) +
      " Keep `C_NV1_m` unchanged and verify the final changes.";
    const brief = buildCostTaskRoutingBrief(task, "test-account");
    expect(brief.length).toBeGreaterThan(4096);
    for (const value of [
      "test-account",
      "/home/",
      "192.0.2.10",
      "synthetic-secret-token",
      "synthetic-test-key",
      "internal.example",
    ]) {
      expect(brief).not.toContain(value);
    }
    expect(brief).toContain("Implement the plan");
    expect(brief).toContain("```python\nverify_layout()\n```");
    expect(brief).toContain("`C_NV1_m`");
    expect(brief).toContain("verify the final changes");
  });

  it("keeps an advanced instruction in the middle of an otherwise routine long task", async () => {
    const task =
      "Review the supplied measurements. " +
      "existing measurement ".repeat(180) +
      "Derive the layout geometry and implement a new routing algorithm. " +
      "existing measurement ".repeat(180) +
      "Return the checked result.";
    await classifyCostTask({ ...params, task });
    expect(JSON.parse(requestBody().messages[1].content)).toEqual({ task });
  });

  it("does not impose an arbitrary character cap on the current task", async () => {
    const task = "Review the design and implement the requested changes. ".repeat(500).trim();
    expect(await classifyCostTask({ ...params, task })).toBe("primary");
    expect(JSON.parse(requestBody().messages[1].content)).toEqual({ task });
  });

  it("falls back only after a real context-limit rejection, without retries or leaking task text", async () => {
    const task = "OVERSIZED_PRIVATE_TASK ".repeat(900);
    respond({ error: { code: "context_length_exceeded", message: task } }, 400);
    expect(await classifyCostTask({ ...params, task })).toBe("secondary");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requestBody().messages[1].content)).toEqual({ task: task.trim() });
    expect(logInfo).toHaveBeenCalledWith(
      "cost task route",
      expect.objectContaining({ route: "secondary", source: "unavailable" }),
    );
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("OVERSIZED_PRIVATE_TASK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("omits private metadata without replacing the current task with a summary", async () => {
    const task = "Implement and verify the geometry changes.";
    await classifyCostTask({
      ...params,
      task: task + " <user_info>" + "private metadata ".repeat(1500) + "</user_info>",
    });
    expect(JSON.parse(requestBody().messages[1].content)).toEqual({
      task: task + " [user metadata omitted]",
    });
  });

  it("redacts quoted secret fields and whole identities without damaging ordinary words", () => {
    const text = buildCostTaskRoutingBrief(
      'Implement IO coordination for io. {"apiKey":"synthetic-key-value"} <user_info>synthetic-user-metadata</user_info>',
      "io",
    );
    expect(text).not.toContain("synthetic-key-value");
    expect(text).not.toContain("synthetic-user-metadata");
    expect(text).toContain("coordination");
    expect(text).toContain("[agent]");
  });

  it("does not invent a provider endpoint when the classifier provider is absent", async () => {
    expect(await classifyCostTask({ ...params, config: { agents: cfg.agents } })).toBe("secondary");
    expect(resolveUsableCustomProviderApiKey).not.toHaveBeenCalled();
  });

  it("defaults unavailable model/auth to the worker without a fallback model call", async () => {
    vi.mocked(resolveUsableCustomProviderApiKey).mockImplementation(() => {
      throw new Error("private auth error");
    });
    expect(await classifyCostTask(params)).toBe("secondary");
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("aborts a slow classifier without retries or accepting a late result", async () => {
    vi.useFakeTimers();
    let finishRequest!: (value: Awaited<ReturnType<typeof fetchWithSsrFGuard>>) => void;
    vi.mocked(fetchWithSsrFGuard).mockReturnValue(
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
    );
    const pending = classifyCostTask(params);
    await vi.advanceTimersByTimeAsync(COST_CLASSIFIER_TIMEOUT_MS);
    expect(await pending).toBe("secondary");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchWithSsrFGuard).mock.calls[0][0].signal?.aborted).toBe(true);
    finishRequest({
      response: new Response(JSON.stringify(reply())),
      release,
      finalUrl: "https://models.example/v1/chat/completions",
    });
    vi.useRealTimers();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("propagates cancellation to an in-flight classifier request", async () => {
    const controller = new AbortController();
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async (options) => {
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      throw new Error("aborted");
    });
    expect(await classifyCostTask({ ...params, signal: controller.signal })).toBe("secondary");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });
});

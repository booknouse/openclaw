import { createRequire } from "node:module";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

let sdkUserAgent: string | undefined;
function defaultOpenAiUserAgent(): string {
  if (!sdkUserAgent) {
    // Resolve the SDK used by pi-ai, not an unrelated hoisted OpenAI version.
    const providerRequire = createRequire(import.meta.resolve("@mariozechner/pi-ai"));
    const { VERSION } = providerRequire("openai/version") as { VERSION: string };
    sdkUserAgent = `OpenAI/JS ${VERSION}`;
  }
  return sdkUserAgent;
}

function isOpenAiHttp(model: Model<Api>): boolean {
  return model.api === "openai-completions" || model.api === "openai-responses";
}

function userAgentValue(headers?: Record<string, string>): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "user-agent")?.[1];
}

export function agentRequestHeaders(
  model: Model<Api>,
  agentId: string,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  const headers = { ...requestHeaders };
  const base =
    userAgentValue(requestHeaders) ?? userAgentValue(model.headers) ?? defaultOpenAiUserAgent();
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "user-agent") {
      delete headers[name];
    }
  }
  // Keep one current attribution, even when a caller reuses a previously tagged model.
  const clean = base.replace(/(?:^|\s)OpenClaw-Agent\/\S+/g, "").trim();
  headers["User-Agent"] =
    `${clean} OpenClaw-Agent/${encodeURIComponent(Buffer.from(agentId.trim(), "utf8").toString("utf8"))}`;
  return headers;
}

export function withAgentUserAgent<T extends Api>(model: Model<T>, agentId?: string): Model<T> {
  if (!agentId?.trim() || !isOpenAiHttp(model)) {
    return model;
  }
  return { ...model, headers: agentRequestHeaders(model, agentId, model.headers) };
}

/** Runs on every model request, including tool continuations and provider retries. */
export function wrapStreamWithAgentUserAgent(inner: StreamFn, agentId: string): StreamFn {
  return (model, context, options) => {
    if (!agentId.trim() || !isOpenAiHttp(model)) {
      return inner(model, context, options);
    }
    return inner(model, context, {
      ...options,
      headers: agentRequestHeaders(model, agentId, options?.headers),
    });
  };
}

import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeAgentId,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "./agent-scope.js";
import { classifyCostTask } from "./cost-task-classifier.js";
import { withCostTaskSpawnContext } from "./cost-task-protocol.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveSubagentConfiguredModelSelection,
  type ModelRef,
} from "./model-selection.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { AnyAgentTool } from "./tools/common.js";
import { ToolInputError } from "./tools/common.js";

export type CostRoutingModels = { primary: ModelRef; worker: ModelRef };
export type CostRoutingRole = "direct" | "orchestrator" | "primary";
export type CostRoutingExecutionState = {
  spawns: Map<string, Promise<Awaited<ReturnType<AnyAgentTool["execute"]>>>>;
};
type CostRoutingExecutionPlan = CostRoutingModels & {
  role: CostRoutingRole;
  executionState?: CostRoutingExecutionState;
};
type CostRoutingTurn = {
  role: "primary" | "orchestrator";
  executionState: CostRoutingExecutionState;
};
const lastExecutions = new Map<string, CostRoutingTurn>();
const childExecutions = new Map<string, CostRoutingTurn>();
const executionOwners = new WeakMap<CostRoutingExecutionState, string>();

/** Resolve aliases before comparing: two names for the same model must remain a no-op. */
export function resolveCostRoutingModels(
  cfg: OpenClawConfig,
  agentId: string,
): CostRoutingModels | undefined {
  const policy =
    resolveAgentConfig(cfg, agentId)?.modelRouting ?? cfg.agents?.defaults?.modelRouting;
  if (policy !== "cost") {
    return undefined;
  }
  const primary = resolveDefaultModelForAgent({ cfg, agentId });
  const raw = resolveSubagentConfiguredModelSelection({ cfg, agentId });
  if (!raw) {
    return undefined;
  }
  const worker = resolveModelRefFromString({
    raw,
    defaultProvider: primary.provider,
    aliasIndex: buildModelAliasIndex({ cfg, defaultProvider: primary.provider }),
  })?.ref;
  if (
    !worker ||
    modelKey(primary.provider, primary.model) === modelKey(worker.provider, worker.model)
  ) {
    return undefined;
  }
  const allowed = resolveAllowedModelRef({
    cfg,
    catalog: [],
    raw,
    defaultProvider: primary.provider,
    defaultModel: primary.model,
  });
  return "error" in allowed ? undefined : { primary, worker };
}

/** Deliberately conservative, local-only classification: no paid classifier request. */
export function isSelfContainedTextTask(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || text.length > 3000 || /(?:<[^>]+>|https?:\/\/|\[media attached:)/i.test(text)) {
    return false;
  }
  // Short follow-ups and references may depend on unfinished work in the transcript.
  if (
    /(?:之前|前面|上面|刚才|继续|附件|这个|那个|上述|此前|\b(?:previous|above|earlier|attached|continue|this|that)\b)/i.test(
      text,
    )
  ) {
    return false;
  }
  if (/^(?:你好|您好|早上好|谢谢|感谢|hi|hello|thanks|thank you)[!！。,.，\s]*$/i.test(text)) {
    return true;
  }
  if (
    /^(?:(?:请|帮我)\s*)?(?:计算|calculate)\s*[:：]?\s*[\d\s.+*/%()−-]+[=?？。!！]*$/i.test(text)
  ) {
    return true;
  }
  // Only explicit transformations with inline source material qualify. Unknown requests
  // (including coding, investigations, tool use, and acceptance follow-ups) stay primary.
  return /^(?:(?:请|帮我)\s*)?(?:(?:翻译|润色|改写|总结|摘要)(?:为|成|以下|这段文字|文字|文本|内容|英文|中文|英语|汉语|日文|日语|法文|德文|一句话|简短|一下|\s){0,20}|(?:translate|rewrite|summarize|proofread)(?:\s+(?:the|following|text|into|in|english|chinese|briefly)){0,8})\s*[:：]\s*\S[\s\S]+$/i.test(
    text,
  );
}

export function resolveCostRoutingPlan(
  params: RunEmbeddedPiAgentParams,
): (CostRoutingModels & { role: CostRoutingRole }) | undefined {
  if (
    !params.config ||
    params.trigger !== "user" ||
    params.spawnedBy ||
    isSubagentSessionKey(params.sessionKey) ||
    isCronSessionKey(params.sessionKey) ||
    params.disableTools ||
    params.clientTools?.length ||
    params.images?.length ||
    params.authProfileIdSource === "user"
  ) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const models = resolveCostRoutingModels(params.config, sessionAgentId);
  if (
    !models ||
    modelKey(params.provider ?? "", params.model ?? "") !==
      modelKey(models.primary.provider, models.primary.model)
  ) {
    // Explicit session/model overrides and fallback attempts retain their normal behavior.
    return undefined;
  }
  const external = !params.inputProvenance || params.inputProvenance.kind === "external_user";
  return {
    ...models,
    role:
      external && isSelfContainedTextTask(params.modelRoutingPrompt ?? params.prompt)
        ? "direct"
        : "orchestrator",
  };
}

const ORCHESTRATION_TOOLS = new Set([
  "agents_list",
  "read",
  "session_status",
  "remote_task_result",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
]);

export async function resolveCostRoutingExecutionPlan(
  params: RunEmbeddedPiAgentParams,
): Promise<CostRoutingExecutionPlan | undefined> {
  const plan = resolveCostRoutingPlan(params);
  if (!plan || plan.role === "direct") {
    return plan;
  }
  params.abortSignal?.throwIfAborted();
  const key = JSON.stringify([
    params.agentId,
    params.agentDir,
    params.workspaceDir,
    params.sessionKey,
    params.sessionId,
    plan.primary,
    plan.worker,
  ]);
  if (params.inputProvenance && params.inputProvenance.kind !== "external_user") {
    const source = params.inputProvenance.sourceSessionKey;
    const inherited = source
      ? childExecutions.get(JSON.stringify([key, source]))
      : lastExecutions.get(key);
    return { ...plan, ...(inherited ?? { role: "primary" as const }) };
  }
  const signal = AbortSignal.any([
    ...(params.abortSignal ? [params.abortSignal] : []),
    AbortSignal.timeout(Math.max(1, Math.floor(params.timeoutMs))),
  ]);
  const route = await classifyCostTask({
    config: params.config!,
    agentId: resolveSessionAgentIds({
      config: params.config!,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }).sessionAgentId,
    agentDir: params.agentDir,
    task: params.modelRoutingPrompt ?? params.prompt,
    signal,
  }).catch(() => "secondary" as const);
  signal.throwIfAborted();
  const role = route === "primary" ? "primary" : "orchestrator";
  const execution: CostRoutingTurn = { role, executionState: { spawns: new Map() } };
  executionOwners.set(execution.executionState, key);
  if (!lastExecutions.has(key) && lastExecutions.size >= 256) {
    lastExecutions.delete(lastExecutions.keys().next().value!);
  }
  lastExecutions.set(key, execution);
  return { ...plan, ...execution };
}

function spawnFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) =>
        isRecord(value)
          ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
}

export const COST_ORCHESTRATOR_PROMPT = [
  "Cost routing is enabled. You are the planner and final reviewer; delegate concrete execution to embedded subagents with sessions_spawn (runtime=subagent).",
  "This task was classified for the configured secondary execution model. Omit model overrides. Give each worker a bounded, self-contained brief: goal, user constraints and authorizations, required evidence, relevant paths, and acceptance criteria. Do not copy the full conversation or raw tool logs.",
  "Prefer one worker for related steps. Steer it only while running. The cost controller can continue an explicit safe partial result once in place; do not create replacement workers to reset that limit or report progress. After spawning, yield with sessions_yield and wait for push completion events; do not poll.",
  "A completed worker may leave remote work pending. Preserve its background_task_id/task_id. For a user-requested result check, use the authorized read-only remote_task_result tool; do not spawn another worker to recover that result or repeat the remote operation. Never treat a missing or inaccessible result as execution failure.",
  "Require the worker to run appropriate deterministic checks and return concise results, evidence/artifact paths, check outcomes, and unresolved risks. Read relevant evidence when needed, assess it against the original request, and only then give the final answer. Do not claim work passed without evidence. Request targeted corrections from the same worker when necessary.",
  "Preserve all existing authorization, tool, sandbox, and data-access boundaries. If delegation is unavailable, report the blocker without claiming execution or requesting broader access.",
].join("\n");

export const COST_PRIMARY_PROMPT =
  "Cost routing selected primary execution. Execute the authorized task directly in this session with your available tools. Do not spawn another primary-model session to execute the same task. Delegate only genuinely independent routine work to the configured secondary model when useful. Preserve all existing permissions and verify actual changes before reporting completion.";

/** Filter an already-authorized tool list; never grant tools denied by normal policy. */
export function applyCostRoutingToolPolicy(
  tools: AnyAgentTool[],
  role: CostRoutingRole | undefined,
  context?: {
    workerModel: string;
    primaryModel?: string;
    agentId: string;
    agentDir?: string;
    requesterSessionKey?: string;
    config?: OpenClawConfig;
    executionState?: CostRoutingExecutionState;
  },
): { tools: AnyAgentTool[]; systemPrompt?: string } {
  if (!role) {
    return { tools };
  }
  if (context?.config && !resolveCostRoutingModels(context.config, context.agentId)) {
    return { tools };
  }
  if (role === "direct") {
    return { tools: [] };
  }
  if (!tools.some((tool) => tool.name === "sessions_spawn")) {
    // Restricted agents keep their authorized flow rather than losing the ability to act.
    return role === "primary" ? { tools, systemPrompt: COST_PRIMARY_PROMPT } : { tools };
  }
  return {
    tools: tools
      .filter((tool) => role === "primary" || ORCHESTRATION_TOOLS.has(tool.name))
      .map((tool) => {
        if (tool.name !== "sessions_spawn" || !context) {
          return tool;
        }
        const spawns: CostRoutingExecutionState["spawns"] =
          context.executionState?.spawns ?? new Map();
        return {
          ...tool,
          execute: (callId, args, signal, onUpdate) => {
            const input = args as Record<string, unknown>;
            if (input.runtime === "acp") {
              throw new ToolInputError(
                "Cost routing requires runtime=subagent. Disable modelRouting for ACP execution.",
              );
            }
            const sameAgent =
              typeof input.agentId !== "string" ||
              normalizeAgentId(input.agentId) === normalizeAgentId(context.agentId);
            const costContext =
              sameAgent && context.config && context.requesterSessionKey
                ? {
                    requesterSessionKey: context.requesterSessionKey,
                    agentId: context.agentId,
                    onChildSession: (child: string) => {
                      const state = context.executionState;
                      const owner = state && executionOwners.get(state);
                      if (!state || !owner) {
                        return;
                      }
                      if (childExecutions.size >= 512) {
                        childExecutions.delete(childExecutions.keys().next().value!);
                      }
                      childExecutions.set(JSON.stringify([owner, child]), {
                        role,
                        executionState: state,
                      });
                    },
                  }
                : undefined;
            const execute = (model?: string) => {
              signal?.throwIfAborted();
              const run = () =>
                tool.execute(
                  callId,
                  {
                    ...input,
                    ...(model ? { model } : {}),
                    ...(typeof input.task === "string"
                      ? {
                          task: `${input.task}\n\n${COST_WORKER_PROMPT}`,
                        }
                      : {}),
                  },
                  signal,
                  onUpdate,
                );
              return costContext ? withCostTaskSpawnContext(costContext, run) : run();
            };
            signal?.throwIfAborted();
            if (!sameAgent) {
              return execute();
            }
            const fingerprint = spawnFingerprint({ ...input, model: context.workerModel });
            let pending = spawns.get(fingerprint);
            if (!pending) {
              if (spawns.size >= 32) {
                throw new ToolInputError(
                  "Cost routing spawn budget reached for this request; inspect existing tasks instead of resubmitting.",
                );
              }
              pending = Promise.resolve().then(() => execute(context.workerModel));
              spawns.set(fingerprint, pending);
            }
            return pending.then((result) => {
              signal?.throwIfAborted();
              return result;
            });
          },
        };
      }),
    systemPrompt: role === "primary" ? COST_PRIMARY_PROMPT : COST_ORCHESTRATOR_PROMPT,
  };
}

export const COST_WORKER_PROMPT =
  "Cost routing worker: complete the bounded task, preserve the supplied user constraints and authorizations, and run appropriate checks. Return a concise result with evidence/artifact paths, check outcomes, and unresolved blockers. Avoid full transcripts, raw logs, repeated polling, or spawning agents just for progress updates.";

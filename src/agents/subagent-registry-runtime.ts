export {
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  countPendingDescendantRunsExcludingRun,
  isSubagentSessionRunActive,
  isCostTaskContinuationAllowed,
  listSubagentRunsForRequester,
  replaceSubagentRunAfterSteer,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry.js";

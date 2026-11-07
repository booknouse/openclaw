import { isRecord } from "../utils.js";

const EXECUTION_TOOLS = new Set([
  "exec",
  "process",
  "remote_run",
  "remote_task",
  "remote_task_result",
]);
const DENIED_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "AUTH_EXPIRED",
  "TOKEN_EXPIRED",
  "INVALID_TOKEN",
  "INSUFFICIENT_SCOPE",
]);
const DENIED =
  /\b(?:EACCES|EPERM|unauthorized|unauthenticated|forbidden|permission denied|access denied|not authorized|authentication required|credentials required|authorization expired|authorization denied|authentication failed|approval required|execution denied)\b|(?:授权|权限).{0,12}(?:拒绝|不足|过期)|需要.{0,8}(?:批准|审批)/iu;

/** A worker's recovery hint alone is not operational evidence or permission. */
export function hasRecoverableCostImplementationFailure(messages: unknown[]): boolean {
  let observed = false;
  for (const message of messages) {
    if (!isRecord(message) || (message.role !== "toolResult" && message.role !== "tool")) {
      continue;
    }
    let details = isRecord(message.details) ? message.details : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("\n");
    if (!Object.keys(details).length && text.length <= 128 * 1024) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) {
          details = parsed;
        }
      } catch {
        /* Plain execution output. */
      }
    }
    const nested = isRecord(details.result) ? details.result : {};
    const states = [details, nested];
    // Bound analysis and fail closed, even for terminal-looking transport errors.
    if (
      text.length > 128 * 1024 ||
      states.some(
        (state) =>
          (state.execution_state ?? state.executionState) === "unknown" ||
          state.needs_result_lookup === true ||
          state.requiresApproval === true ||
          state.approvalRequired === true ||
          ["running", "pending", "queued", "cancelled", "canceled", "aborted"].includes(
            String(state.status),
          ),
      )
    ) {
      return false;
    }
    const rawError = details.error || nested.error;
    const error = isRecord(rawError) ? rawError : {};
    const codeValue =
      details.code ?? details.errorCode ?? nested.code ?? nested.errorCode ?? error.code;
    const code =
      typeof codeValue === "string"
        ? codeValue
        : typeof codeValue === "number"
          ? codeValue.toString()
          : "";
    const errorValue = typeof rawError === "string" ? rawError : error.message;
    const errorText = typeof errorValue === "string" ? errorValue : "";
    if (rawError && !errorText && !code) {
      return false;
    }
    const diagnostic = `${errorText} ${code}\n${text}`;
    if (
      DENIED.test(diagnostic.replace(/[_-]/gu, " ")) ||
      DENIED_CODES.has(code.toUpperCase()) ||
      /\bHTTP(?: status)?[:\s]+(?:401|403)\b/iu.test(diagnostic) ||
      [401, 403].includes(
        Number(
          details.statusCode ??
            details.httpStatus ??
            nested.statusCode ??
            nested.httpStatus ??
            error.statusCode ??
            codeValue,
        ),
      )
    ) {
      return false;
    }
    const exit = details.exitCode ?? details.exit_code ?? nested.exitCode ?? nested.exit_code;
    if (["cancelled", "canceled", "aborted"].includes(String(details.status))) {
      return false;
    }
    const failed =
      (typeof exit === "number" && Number.isInteger(exit) && exit !== 0) ||
      ((details.execution_state ?? details.executionState) === "not_started" &&
        (message.isError === true || details.status === "error"));
    if (EXECUTION_TOOLS.has(String(message.toolName ?? message.name)) && failed) {
      observed = true;
    }
  }
  return observed;
}

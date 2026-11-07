import { describe, expect, it } from "vitest";
import { hasRecoverableCostImplementationFailure } from "./cost-task-recovery.js";
const result = (text: string, details: object = { status: "completed", exitCode: 1 }) => ({
  role: "toolResult",
  toolName: "exec",
  toolCallId: "failed-implementation",
  details,
  content: [{ type: "text", text }],
});
describe("generic implementation recovery evidence", () => {
  it.each(["exec", "process", "remote_run", "remote_task", "remote_task_result"])(
    "uses the same ended-execution rule for %s",
    (toolName) => {
      const message = { ...result("implementation failed"), toolName };
      expect(hasRecoverableCostImplementationFailure([message])).toBe(true);
    },
  );
  it("reads the normal nested remote result envelope, but never treats unknown execution as failed", () => {
    const message = {
      role: "toolResult",
      toolName: "remote_task_result",
      toolCallId: "read-result",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "failed",
            task_id: "existing",
            result: { exit_code: 2, error: "Unsupported implementation" },
          }),
        },
      ],
    };
    expect(hasRecoverableCostImplementationFailure([message])).toBe(true);
    message.content[0].text = JSON.stringify({
      status: "failed",
      task_id: "existing",
      result: { exit_code: 2, execution_state: "unknown" },
    });
    expect(hasRecoverableCostImplementationFailure([message])).toBe(false);
    message.content[0].text = JSON.stringify({
      status: "failed",
      task_id: "existing",
      result: { exit_code: 2, error: { code: "FORBIDDEN", message: "Denied" } },
    });
    expect(hasRecoverableCostImplementationFailure([message])).toBe(false);
  });

  it.each([
    "A required optional module was not installed",
    "Compiler rejected this syntax",
    "Renderer cannot use the selected output format",
    "A supplied command flag is unsupported",
    "所选算法实现的数值检查失败",
  ])("accepts settled failure evidence without a library/domain rule: %s", (text) => {
    expect(hasRecoverableCostImplementationFailure([result(text)])).toBe(true);
  });
  it("does not treat a worker's prose or successful command as a failure", () => {
    expect(
      hasRecoverableCostImplementationFailure([
        { role: "assistant", content: [{ type: "text", text: "failed" }] },
      ]),
    ).toBe(false);
    expect(
      hasRecoverableCostImplementationFailure([
        result("failed", { status: "completed", exitCode: 0 }),
      ]),
    ).toBe(false);
  });
  it("requires a failed exit or explicit not-started evidence, not just an error label", () => {
    expect(
      hasRecoverableCostImplementationFailure([
        result("implementation failed", { status: "error" }),
      ]),
    ).toBe(false);
    expect(
      hasRecoverableCostImplementationFailure([
        result("invalid argument", { status: "error", execution_state: "not_started" }),
      ]),
    ).toBe(true);
  });
  it.each([
    result("Permission denied"),
    result("403:authorization_expired"),
    result("HTTP status 403"),
    result("error", { status: "completed", exitCode: 1, code: "TOKEN_EXPIRED" }),
    result("EACCES"),
    result("授权已过期"),
    result("error", { status: "error", code: "PERMISSION_DENIED" }),
    result("error", { status: "error", httpStatus: 403 }),
    result("error", { status: "error", requiresApproval: true }),
    result("error", { status: "error", execution_state: "unknown" }),
    result("error", { status: "completed", needs_result_lookup: true }),
  ])("refuses permission and execution-uncertainty evidence", (failure) => {
    expect(hasRecoverableCostImplementationFailure([result("technical failure"), failure])).toBe(
      false,
    );
  });
});

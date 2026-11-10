import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelForegroundExecForSession } from "../../agents/bash-process-cancel.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { chatHandlers } from "./chat.js";

vi.mock("../../agents/bash-process-cancel.js", () => ({
  cancelForegroundExecForSession: vi.fn(),
}));

describe("chat.abort after the model run has ended", () => {
  beforeEach(() => {
    vi.mocked(cancelForegroundExecForSession).mockReset();
  });

  it("lets the administrator stop pending foreground exec for the exact session", async () => {
    vi.mocked(cancelForegroundExecForSession).mockReturnValue(true);
    const respond = await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context: createChatAbortContext(),
      request: { sessionKey: "main" },
      client: { connect: { scopes: ["operator.admin"] } },
    });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ aborted: true, runIds: [] });
    expect(cancelForegroundExecForSession).toHaveBeenCalledWith("main");
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ foregroundExecChecked: true });
  });

  it("does not expand non-administrator cancellation authority", async () => {
    vi.mocked(cancelForegroundExecForSession).mockReturnValue(true);
    const respond = await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context: createChatAbortContext(),
      request: { sessionKey: "main" },
      client: { connect: { scopes: ["operator.write"] } },
    });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ aborted: false, runIds: [] });
    expect(cancelForegroundExecForSession).not.toHaveBeenCalled();
  });

  it("cleans up yielded foreground work for an authorized active run", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["active", createActiveRun("main")]]),
    });
    const respond = await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId: "active" },
      client: { connect: { scopes: ["operator.admin"] } },
    });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ aborted: true, runIds: ["active"] });
    expect(cancelForegroundExecForSession).toHaveBeenCalledWith("main");
  });

  it("keeps an explicit expired run ID from cancelling other session work", async () => {
    const respond = await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context: createChatAbortContext(),
      request: { sessionKey: "main", runId: "expired-run" },
      client: { connect: { scopes: ["operator.admin"] } },
    });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ aborted: false, runIds: [] });
    expect(cancelForegroundExecForSession).not.toHaveBeenCalled();
  });
});

import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ sessions: {} as Record<string, unknown> }));
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => h.sessions,
  resolveStorePath: () => "test",
}));
import { foregroundRemoteContext } from "./foreground-remote-session.js";
const root = "agent:alice:tenant:alice:web:conversation:role:user";
const child = "agent:alice:subagent:child";
beforeEach(() => {
  h.sessions = {};
});
it("enables business foreground ownership with routing off without changing a model", () => {
  expect(foregroundRemoteContext(root, { agents: { defaults: { modelRouting: "off" } } })).toEqual(
    {},
  );
  expect(foregroundRemoteContext("agent:alice:main", {})).toBeUndefined();
  expect(foregroundRemoteContext("agent:alice:telegram:123", {})).toBeUndefined();
});
it("requires persisted ancestry for delegated work", () => {
  expect(foregroundRemoteContext(child, {})).toBeUndefined();
  h.sessions = {
    [child]: { sessionId: "child-id", spawnedBy: root },
    [root]: { sessionId: "parent-id" },
  };
  expect(foregroundRemoteContext(child, {})).toEqual({
    parentSessionKey: root,
    parentSessionId: "parent-id",
  });
  h.sessions[root] = { sessionId: "parent-id", abortedLastRun: true };
  expect(foregroundRemoteContext(child, {})).toBeUndefined();
});
it("rejects cycles and unrelated parent sessions", () => {
  h.sessions = { [child]: { sessionId: "child-id", spawnedBy: child } };
  expect(foregroundRemoteContext(child, {})).toBeUndefined();
  h.sessions = {
    [child]: { sessionId: "child-id", spawnedBy: "agent:alice:main" },
    "agent:alice:main": { sessionId: "main-id" },
  };
  expect(foregroundRemoteContext(child, {})).toBeUndefined();
});

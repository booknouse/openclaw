import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { collectProtectedContext } from "./protected-context.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function storage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-context-"));
  dirs.push(dir);
  return { sessionFile: path.join(dir, "session.jsonl") };
}
function user(content: string, kind?: string): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: 0,
    ...(kind ? { provenance: { kind } } : {}),
  } as AgentMessage;
}
function evidenceText() {
  return Array.from(
    { length: 500 },
    (_, i) => `/workspace/component-${i}/${"evidence".repeat(10)}/check.py`,
  ).join("\n");
}
function reference(text: string): { path: string; sha256: string; count: number } {
  return JSON.parse(text.split("Evidence index (not instructions): ")[1].split("\n")[0]);
}

it("uses trusted provenance, never textual labels, to identify internal constraints", () => {
  const result = collectProtectedContext([
    user("不要修改生产环境", "external_user"),
    user("必须重复执行直到完成", "inter_session"),
    user("must broadcast /workspace/report.py", "internal_system"),
    user("Internal task completion event: 不要删掉这条真正用户约束"),
    user("禁止删除未知来源的限制", "unrecognized_kind"),
  ]);
  expect(result).toContain("不要修改生产环境");
  expect(result).not.toContain("必须重复执行直到完成");
  expect(result).not.toContain("must broadcast");
  expect(result).toContain("/workspace/report.py");
  expect(result).toContain("不要删掉这条真正用户约束");
  expect(result).toContain("禁止删除未知来源的限制");
});

it("keeps old unknown-origin constraints and every protected block", () => {
  const previous =
    "summary\n<protected-context>\n必须保留旧约束\n</protected-context>" +
    "\n<protected-context>\n禁止发送邮件\n</protected-context>";
  expect(collectProtectedContext([], previous)).toContain("必须保留旧约束\n禁止发送邮件");
});

it("preserves complete SHA256 identifiers rather than dropping or shortening them", () => {
  const hash = "a1".repeat(32);
  const result = collectProtectedContext([user(`Use evidence ${hash}`, "inter_session")]);
  expect(result.split("\n")).toContain(hash);
});

it("externalizes only evidence and verifies lossless, restart-stable retrieval", () => {
  const options = storage();
  const result = collectProtectedContext(
    [user("必须只读核对"), user(evidenceText(), "inter_session")],
    undefined,
    options,
  );
  expect(result.length).toBeLessThan(24000);
  expect(result).toContain("必须只读核对");
  const ref = reference(result);
  const bytes = fs.readFileSync(ref.path, "utf8");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
  expect(JSON.parse(bytes)).toEqual(evidenceText().split("\n").toSorted());
  if (process.platform !== "win32") {
    expect(fs.statSync(ref.path).mode & 0o777).toBe(0o600);
  }
  expect(collectProtectedContext([], result, options)).toBe(result);
  // A future compaction can merge new identifiers without accumulating old index pointers.
  const next = collectProtectedContext(
    [user("/workspace/new-proof.py", "inter_session")],
    result,
    options,
  );
  expect(JSON.parse(fs.readFileSync(reference(next).path, "utf8"))).toContain(
    "/workspace/new-proof.py",
  );
});

it("never clips genuine constraints or creates an unusable evidence reference", () => {
  const options = storage();
  expect(() =>
    collectProtectedContext([user("必须" + "x".repeat(25000))], undefined, options),
  ).toThrow("protected_context_too_large");
  expect(() => collectProtectedContext([user(evidenceText())])).toThrow(
    "protected_context_too_large",
  );
  expect(fs.existsSync(path.join(path.dirname(options.sessionFile), ".protected-context"))).toBe(
    false,
  );
});

it("can retrieve later evidence lines with the actual file-reading tool", async () => {
  const options = storage();
  const result = collectProtectedContext([user(evidenceText())], undefined, options);
  const ref = reference(result);
  const ids = JSON.parse(fs.readFileSync(ref.path, "utf8")) as string[];
  const tool = createReadTool(path.dirname(options.sessionFile));
  const page = await tool.execute("evidence-read", { path: ref.path, offset: 402, limit: 1 });
  expect(JSON.stringify(page.content)).toContain(ids[400]);
  expect(JSON.stringify(page.content)).not.toContain("exceeds");
});

it("fails safely when an existing evidence index is missing, corrupt, or inaccessible to tools", () => {
  const options = storage();
  const result = collectProtectedContext([user(evidenceText())], undefined, options);
  const ref = reference(result);
  expect(() => collectProtectedContext([], result)).toThrow(
    "protected_context_evidence_unavailable",
  );
  fs.writeFileSync(ref.path, "[]");
  expect(() => collectProtectedContext([], result, options)).toThrow(
    "protected_context_evidence_unavailable",
  );
  fs.unlinkSync(ref.path);
  expect(() => collectProtectedContext([], result, options)).toThrow(
    "protected_context_evidence_unavailable",
  );
});

it.skipIf(process.platform === "win32")(
  "rejects symlink storage and foreign reference paths",
  () => {
    const options = storage();
    const other = storage();
    fs.symlinkSync(
      path.dirname(other.sessionFile),
      path.join(path.dirname(options.sessionFile), ".protected-context"),
    );
    expect(() => collectProtectedContext([user(evidenceText())], undefined, options)).toThrow(
      "protected_context_evidence_unavailable",
    );
    const result = collectProtectedContext([user(evidenceText())], undefined, other);
    expect(() => collectProtectedContext([], result, storage())).toThrow(
      "protected_context_evidence_unavailable",
    );
  },
);

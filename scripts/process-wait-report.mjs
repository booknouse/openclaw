import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Offline, read-only summary. Counts are diagnostic observations, not a bill.
const files = process.argv.slice(2);
if (!files.length) {
  throw new Error("Usage: node scripts/process-wait-report.mjs <gateway-json-log> [...]");
}
const polls = new Map();
const usage = new Map();
const notifications = {};
for (const file of files) {
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const event = [row, ...Object.values(row)].find(
      (v) =>
        v && typeof v === "object" && typeof v.event === "string" && v.event.startsWith("process."),
    );
    if (!event) {
      continue;
    }
    if (event.event === "process.poll.result") {
      polls.set(`${event.sessionKey ?? ""}:${event.toolCallId}`, event);
    }
    if (event.event === "process.poll.model_usage") {
      usage.set(`${event.runId}:${event.toolCallIds?.join(",")}`, event);
    }
    if (event.event.startsWith("process.notification.")) {
      const key = `${event.event}:${event.status ?? ""}:${event.reason ?? ""}`;
      notifications[key] = (notifications[key] ?? 0) + 1;
    }
  }
}
const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
const observed = [...polls.values()];
const empty = observed.filter((p) => !p.hasOutput && !p.exited);
const allUsage = [...usage.values()];
const emptyUsage = allUsage.filter(
  (u) =>
    u.toolCallIds?.length &&
    u.toolCallIds.every((id) => {
      const p = polls.get(`${u.sessionKey ?? ""}:${id}`);
      return p && !p.hasOutput && !p.exited;
    }),
);
const tokens = (rows) =>
  Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "total"].map((k) => [k, sum(rows, k)]),
  );
console.log(
  JSON.stringify(
    {
      polls: observed.length,
      emptyPolls: empty.length,
      coalesced: observed.filter((p) => p.coalesced).length,
      totalCallerWaitMs: sum(observed, "waitedMs"),
      pollModelCalls: allUsage.length,
      pollModelUsage: tokens(allUsage),
      emptyPollModelCalls: emptyUsage.length,
      emptyPollModelUsage: tokens(emptyUsage),
      notifications,
      note: "Cache reads are separate; these observations do not imply all measured tokens are waste or monetary cost.",
    },
    null,
    2,
  ),
);

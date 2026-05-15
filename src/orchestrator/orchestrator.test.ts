import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { FakeTracker, issue } from "../testing/fakes.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { Orchestrator, sortForDispatch } from "./orchestrator.js";

describe("orchestrator", () => {
  test("sorts dispatch by priority, created_at, and identifier", () => {
    const sorted = sortForDispatch([
      issue({ identifier: "B", priority: null, created_at: "2026-01-01T00:00:00.000Z" }),
      issue({ identifier: "C", priority: 2, created_at: "2026-01-03T00:00:00.000Z" }),
      issue({ identifier: "A", priority: 1, created_at: "2026-01-02T00:00:00.000Z" }),
      issue({ identifier: "D", priority: 1, created_at: "2026-01-01T00:00:00.000Z" })
    ]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["D", "A", "C", "B"]);
  });

  test("dispatches eligible issues, records token totals, and schedules continuation retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const serverPath = path.join(root, "fake-codex.mjs");
    await writeFile(serverPath, fakeCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const activeIssue = issue({ id: "i-1", identifier: "ABC-1", state: "Todo" });
    const tracker = new FakeTracker([activeIssue], [], [issue({ id: "i-1", identifier: "ABC-1", state: "Human Review" })]);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      logger: createLogger(() => undefined)
    });
    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const snapshot = orchestrator.snapshot() as { counts: { retrying: number }; codex_totals: { total_tokens: number } };
    expect(snapshot.counts.retrying).toBe(1);
    expect(snapshot.codex_totals.total_tokens).toBe(7);
    await orchestrator.stop();
  });

  test("blocked Todo issue is not dispatched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const cfg = config(root, "node missing.js");
    const blocked = issue({ blocked_by: [{ id: "b", identifier: "ABC-0", state: "Todo" }] });
    const tracker = new FakeTracker([blocked], [], []);
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "body", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      logger: createLogger(() => undefined)
    });
    await orchestrator.tick();
    expect((orchestrator.snapshot() as { counts: { running: number } }).counts.running).toBe(0);
    await orchestrator.stop();
  });
});

function config(root: string, command: string): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "secret",
      project_slug: "demo",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"]
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: path.join(root, "workspaces") },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 2000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

function fakeCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 10);
  }
});
`;
}

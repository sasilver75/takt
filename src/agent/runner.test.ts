import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { AgentRunHandle } from "./runner.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { FakeTracker, issue } from "../testing/fakes.js";

describe("agent runner with fake Codex app-server", () => {
  test("launches app-server in workspace cwd, extracts session IDs, and records usage events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-"));
    const serverPath = path.join(root, "fake-codex.mjs");
    await writeFile(serverPath, fakeCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const events: string[] = [];
    const tracker = new FakeTracker([], [], [issue({ state: "Human Review" })]);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({
        config: {},
        prompt_template: "Implement {{ issue.identifier }}",
        path: path.join(root, "WORKFLOW.md"),
        loaded_at: new Date().toISOString()
      }),
      workspaceManager: manager,
      tracker,
      logger: createLogger(() => undefined),
      onEvent: (event) => events.push(`${event.event}:${event.session_id ?? ""}:${event.absolute_usage?.total_tokens ?? ""}`)
    });
    const result = await handle.run();
    expect(result.ok).toBe(true);
    expect(events).toContain("session_started:thread-1-turn-1:");
    expect(events).toContain("thread/tokenUsage/updated:thread-1-turn-1:30");
    expect(tracker.stateRefreshCalls).toBe(1);
  });

  test("fails the run when Codex requests user input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-user-input-"));
    const serverPath = path.join(root, "fake-codex-user-input.mjs");
    await writeFile(serverPath, fakeCodexUserInputServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const events: string[] = [];
    const tracker = new FakeTracker([], [], []);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({
        config: {},
        prompt_template: "Implement {{ issue.identifier }}",
        path: path.join(root, "WORKFLOW.md"),
        loaded_at: new Date().toISOString()
      }),
      workspaceManager: manager,
      tracker,
      logger: createLogger(() => undefined),
      onEvent: (event) => events.push(event.event)
    });

    const result = await handle.run();

    expect(result).toMatchObject({ ok: false, reason: "turn_input_required" });
    expect(events).toContain("turn_input_required");
    expect(tracker.stateRefreshCalls).toBe(0);
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
      terminal_states: ["Done"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 1000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 2, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 2000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 1000,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

function githubDisabled(): SymphonyConfig["github"] {
  return {
    enabled: false,
    owner: null,
    repo: null,
    api_endpoint: "https://api.github.com",
    token: null,
    remote: "origin",
    base_branch: "main",
    branch_prefix: "symphony",
    pr_ready_file: "SYMPHONY_PR_READY.json",
    evidence_file: "SYMPHONY_EVIDENCE.json",
    draft: false,
    merge: githubMergeDisabled()
  };
}

function githubMergeDisabled(): SymphonyConfig["github"]["merge"] {
  return {
    enabled: false,
    method: "squash",
    require_approval: true,
    require_successful_checks: true,
    require_clean_merge: true,
    delete_branch: true,
    complete_state: null
  };
}

function fakeCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake", codexHome: process.cwd(), platformFamily: "unix", platformOs: "test" } });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" }, cwd: process.cwd(), model: "fake", modelProvider: "fake", serviceTier: null, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: {}, reasoningEffort: null } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "all", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
    }, 10);
  }
});
`;
}

function fakeCodexUserInputServerSource(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake", codexHome: process.cwd(), platformFamily: "unix", platformOs: "test" } });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" }, cwd: process.cwd(), model: "fake", modelProvider: "fake", serviceTier: null, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: {}, reasoningEffort: null } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    setTimeout(() => {
      send({ id: "input-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "choice", question: "Need operator input" }] } });
    }, 10);
  }
});
`;
}

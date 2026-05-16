import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  test("continues active issues on the same app-server thread up to max turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-continuation-"));
    const serverPath = path.join(root, "fake-codex-continuation.mjs");
    await writeFile(serverPath, fakeContinuationCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const events: string[] = [];
    const tracker = new FakeTracker([], [], [issue({ state: "Todo" })]);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({
        config: {},
        prompt_template: "Implement {{ issue.identifier }} exactly once.",
        path: path.join(root, "WORKFLOW.md"),
        loaded_at: new Date().toISOString()
      }),
      workspaceManager: manager,
      tracker,
      logger: createLogger(() => undefined),
      onEvent: (event) => {
        if (event.event === "session_started") events.push(`${event.thread_id}:${event.turn_id}:${event.session_id}`);
      }
    });

    const result = await handle.run();
    const promptLog = await readFile(path.join(manager.workspacePath("ABC-1"), "turn-prompts.log"), "utf8");

    expect(result.ok).toBe(true);
    expect(events).toEqual(["thread-1:turn-1:thread-1-turn-1", "thread-1:turn-2:thread-1-turn-2"]);
    expect(tracker.stateRefreshCalls).toBe(2);
    expect(promptLog).toContain("turn-1:Implement ABC-1 exactly once.");
    expect(promptLog).toContain("turn-2:Continue the same Linear issue from the existing thread history.");
    expect(promptLog.match(/Implement ABC-1 exactly once/g)).toHaveLength(1);
  });

  test("classifies app-server request timeouts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-response-timeout-"));
    const serverPath = path.join(root, "fake-codex-no-response.mjs");
    await writeFile(serverPath, fakeNoResponseCodexServerSource());
    await chmod(serverPath, 0o755);
    const baseConfig = config(root, `node ${serverPath}`);
    const cfg = { ...baseConfig, codex: { ...baseConfig.codex, read_timeout_ms: 80 } };
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Implement {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      tracker: new FakeTracker([], [], []),
      logger: createLogger(() => undefined),
      onEvent: () => undefined
    });

    await expect(handle.run()).resolves.toMatchObject({ ok: false, reason: "response_timeout" });
  });

  test("classifies app-server turn timeouts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-turn-timeout-"));
    const serverPath = path.join(root, "fake-codex-hanging-turn.mjs");
    await writeFile(serverPath, fakeHangingTurnCodexServerSource());
    await chmod(serverPath, 0o755);
    const baseConfig = config(root, `node ${serverPath}`);
    const cfg = { ...baseConfig, codex: { ...baseConfig.codex, turn_timeout_ms: 120 } };
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Implement {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      tracker: new FakeTracker([], [], []),
      logger: createLogger(() => undefined),
      onEvent: () => undefined
    });

    await expect(handle.run()).resolves.toMatchObject({ ok: false, reason: "turn_timeout" });
  });

  test("returns unsupported dynamic tool failures without stalling the turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-agent-unsupported-tool-"));
    const serverPath = path.join(root, "fake-codex-unsupported-tool.mjs");
    await writeFile(serverPath, fakeUnsupportedToolCallServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const events: string[] = [];
    const tracker = new FakeTracker([], [], [issue({ state: "Human Review" })]);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const handle = new AgentRunHandle({
      issue: issue(),
      attempt: null,
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Implement {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      workspaceManager: manager,
      tracker,
      logger: createLogger(() => undefined),
      onEvent: (event) => events.push(`${event.event}:${event.message ?? ""}`)
    });

    const result = await handle.run();
    const response = JSON.parse(await readFile(path.join(manager.workspacePath("ABC-1"), "tool-response.json"), "utf8")) as { result?: { success?: unknown; contentItems?: Array<{ text?: string }> } };

    expect(result.ok).toBe(true);
    expect(response.result?.success).toBe(false);
    expect(response.result?.contentItems?.[0]?.text).toContain("Unsupported tool: not_a_real_tool");
    expect(events).toContain("unsupported_tool_call:not_a_real_tool");
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
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
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

function fakeContinuationCodexServerSource(): string {
  return `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let turnCount = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake", codexHome: process.cwd(), platformFamily: "unix", platformOs: "test" } });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" }, cwd: process.cwd(), model: "fake", modelProvider: "fake", serviceTier: null, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: {}, reasoningEffort: null } });
  if (msg.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    const text = msg.params?.input?.[0]?.text ?? "";
    appendFileSync("turn-prompts.log", turnId + ":" + text + "\\n---\\n");
    send({ id: msg.id, result: { turn: { id: turnId, items: [], itemsView: "all", status: "inProgress", error: null, startedAt: turnCount, completedAt: null, durationMs: null } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, items: [], itemsView: "all", status: "inProgress", error: null, startedAt: turnCount, completedAt: null, durationMs: null } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, items: [], itemsView: "all", status: "completed", error: null, startedAt: turnCount, completedAt: turnCount + 1, durationMs: 1 } } });
    }, 10);
  }
});
`;
}

function fakeNoResponseCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", () => undefined);
`;
}

function fakeHangingTurnCodexServerSource(): string {
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
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
  }
});
`;
}

function fakeUnsupportedToolCallServerSource(): string {
  return `
import { writeFileSync } from "node:fs";
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
      send({ id: "tool-1", method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "not_a_real_tool", arguments: {} } });
    }, 10);
  }
  if (msg.id === "tool-1" && msg.result) {
    writeFileSync("tool-response.json", JSON.stringify(msg));
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "all", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
  }
});
`;
}

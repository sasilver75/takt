import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { PullRequestPublisher, SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { FakeTracker, issue } from "../testing/fakes.js";
import { LocalTracker } from "../testing/localTracker.js";
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
    await waitFor(() => (orchestrator.snapshot() as { counts: { retrying: number } }).counts.retrying === 1, "continuation retry");
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

  test("claims an issue, publishes PR-ready worker commits, comments, and moves to review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr", identifier: "SAM-9", state: "Todo", title: "Ship PR loop" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9-ship-pr-loop", title: "SAM-9: Ship PR loop", created: true };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "pull request publication");

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      issue: { identifier: "SAM-9", state: "In Progress" },
      manifest: { title: "SAM-9: Ship PR loop", verification: ["pnpm test"] }
    });
    expect(tracker.getIssue("i-pr")?.state).toBe("Needs Human");
    expect(tracker.comments[0]?.body).toContain("https://github.test/acme/widgets/pull/9");
    expect(orchestrator.issueSnapshot("SAM-9")).toMatchObject({
      status: "completed",
      tracked: { github_pull_request: { url: "https://github.test/acme/widgets/pull/9" } }
    });
    await tracker.transitionIssue(activeIssue, "In Progress");
    await orchestrator.tick();
    expect(published).toHaveLength(1);
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
      terminal_states: ["Done", "Closed"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 60_000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 2000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

function fakePrReadyCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    setTimeout(() => {
      writeFileSync("SYMPHONY_PR_READY.json", JSON.stringify({ title: "SAM-9: Ship PR loop", summary: "Done", verification: ["pnpm test"], risk: "Low" }));
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 10);
  }
});
`;
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
    draft: false
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

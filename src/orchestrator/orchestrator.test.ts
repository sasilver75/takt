import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DiscoveredPullRequest, DurableStateSnapshot, DurableStateStore, PullRequestInspection, PullRequestPublisher, PullRequestTracker, SymphonyConfig } from "../domain.js";
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

  test("requeues worker follow-up when a published PR has failing checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-followup-"));
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
    const activeIssue = issue({ id: "i-pr-followup", identifier: "SAM-10", state: "Todo", title: "Close PR loop" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 10, url: "https://github.test/acme/widgets/pull/10", branch: "symphony/sam-10-close-pr-loop", title: "SAM-10: Close PR loop", created: published.length === 1 };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return failingInspection();
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "pull request follow-up publication");

    expect(tracker.getIssue("i-pr-followup")?.state).toBe("Needs Human");
    expect(tracker.comments.some((comment) => comment.body.includes("PR follow-up queued") && comment.body.includes("verify"))).toBe(true);
    const promptLog = await readFile(path.join(manager.workspacePath("SAM-10"), "prompts.log"), "utf8");
    expect(promptLog).toContain("Orchestrator follow-up context");
    expect(promptLog).toContain("GitHub checks are failing");
    expect(promptLog).toContain("verify");
    expect(orchestrator.issueSnapshot("SAM-10")).toMatchObject({
      tracked: { github_pull_request_status: { checks_status: "failure" } }
    });
    await orchestrator.stop();
  });

  test("recovers open Symphony PRs after restart and suppresses duplicate dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-recover-"));
    const cfg = {
      ...config(root, "node missing.js"),
      tracker: {
        ...config(root, "node missing.js").tracker,
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
    const activeIssue = issue({ id: "i-pr-recover", identifier: "SAM-11", state: "Todo", title: "Recovered PR should not redispatch" });
    const tracker = new LocalTracker([activeIssue]);
    const pullRequestTracker: PullRequestTracker = {
      async discoverOpen() {
        return [discoveredPullRequest()];
      },
      async inspect() {
        return healthyInspection();
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();

    const snapshot = orchestrator.snapshot() as { counts: { running: number; completed: number; pull_requests: number } };
    expect(snapshot.counts).toMatchObject({ running: 0, completed: 1, pull_requests: 1 });
    expect(orchestrator.issueSnapshot("SAM-11")).toMatchObject({
      status: "completed",
      tracked: {
        github_pr_recovered: true,
        github_pull_request: { number: 11, url: "https://github.test/acme/widgets/pull/11" },
        github_pull_request_status: { checks_status: "success" }
      }
    });
    await orchestrator.stop();
  });

  test("restores durable retry queue and issue history on startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-durable-"));
    const cfg = config(root, "node missing.js");
    const saved: DurableStateSnapshot[] = [];
    const durableStore: DurableStateStore = {
      async load() {
        return durableSnapshot(Date.now() + 60_000);
      },
      async save(snapshot) {
        saved.push(snapshot);
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker: new FakeTracker([], [], []),
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      durableStore,
      logger: createLogger(() => undefined)
    });

    await orchestrator.start();

    expect(orchestrator.snapshot()).toMatchObject({
      counts: { retrying: 1, completed: 1 },
      retrying: [{ issue_id: "retry-1", issue_identifier: "SAM-12", attempt: 2, context: "Fix failing checks" }]
    });
    expect(orchestrator.issueSnapshot("SAM-12")).toMatchObject({
      status: "retrying",
      last_error: "verify failed",
      tracked: { github_pull_request: { number: 12 } }
    });
    await orchestrator.stop();
    expect(saved.at(-1)).toMatchObject({
      retry_attempts: [{ issue_id: "retry-1", identifier: "SAM-12", attempt: 2, context: "Fix failing checks" }],
      completed_issue_ids: ["done-1"]
    });
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
import { appendFileSync, writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    const text = msg.params?.input?.[0]?.text ?? "";
    appendFileSync("prompts.log", text + "\\n---\\n");
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

function failingInspection(): PullRequestInspection {
  return {
    number: 10,
    url: "https://github.test/acme/widgets/pull/10",
    branch: "symphony/sam-10-close-pr-loop",
    title: "SAM-10: Close PR loop",
    state: "open",
    checks_status: "failure",
    review_status: "review_required",
    head_sha: "abc123def456",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #10 is open; checks=failure; review=review_required at abc123def456.",
    checks: [{ name: "verify", status: "completed", conclusion: "failure", details_url: "https://github.test/checks/10" }],
    reviews: [],
    review_comments: []
  };
}

function healthyInspection(): PullRequestInspection {
  return {
    number: 11,
    url: "https://github.test/acme/widgets/pull/11",
    branch: "symphony/sam-11-recovered-pr-should-not-redispatch",
    title: "SAM-11: Recovered PR should not redispatch",
    state: "open",
    checks_status: "success",
    review_status: "review_required",
    head_sha: "def456abc123",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #11 is open; checks=success; review=review_required at def456abc123.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/11" }],
    reviews: [],
    review_comments: []
  };
}

function discoveredPullRequest(): DiscoveredPullRequest {
  return {
    number: 11,
    url: "https://github.test/acme/widgets/pull/11",
    branch: "symphony/sam-11-recovered-pr-should-not-redispatch",
    title: "SAM-11: Recovered PR should not redispatch",
    created: false,
    issue_identifier: "SAM-11"
  };
}

function durableSnapshot(dueAtMs: number): DurableStateSnapshot {
  return {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    retry_attempts: [{ issue_id: "retry-1", identifier: "SAM-12", attempt: 2, due_at_ms: dueAtMs, error: "verify failed", context: "Fix failing checks" }],
    completed_issue_ids: ["done-1"],
    issue_history: [
      {
        issue_id: "retry-1",
        issue_identifier: "SAM-12",
        workspace_path: null,
        restart_count: 1,
        last_error: "verify failed",
        recent_events: [],
        tracked: {
          github_pull_request: {
            number: 12,
            url: "https://github.test/acme/widgets/pull/12",
            branch: "symphony/sam-12-durable-retry",
            title: "SAM-12: Durable retry",
            created: true
          }
        }
      }
    ],
    recent_events: [],
    codex_totals: { input_tokens: 1, output_tokens: 2, total_tokens: 3, seconds_running: 4 },
    codex_rate_limits: null
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

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DurableStateSnapshot, SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { JsonDurableStateStore } from "./jsonStateStore.js";

describe("JSON durable state store", () => {
  test("saves and loads a versioned orchestration snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "takt-state-"));
    const store = new JsonDurableStateStore(() => config(root), createLogger(() => undefined));
    const snapshot = durableSnapshot();

    await store.save(snapshot);

    await expect(store.load()).resolves.toEqual(snapshot);
  });

  test("returns null for corrupt state without throwing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "takt-state-"));
    const logs: string[] = [];
    const store = new JsonDurableStateStore(() => config(root), createLogger((line) => logs.push(line)));
    await store.save(durableSnapshot());
    await writeFile(store.filePath(), "{not-json", "utf8");

    await expect(store.load()).resolves.toBeNull();
    expect(logs.some((line) => line.includes("durable state parse failed"))).toBe(true);
  });
});

function durableSnapshot(): DurableStateSnapshot {
  return {
    schema_version: 1,
    saved_at: "2026-05-15T00:00:00.000Z",
    retry_attempts: [{ issue_id: "issue-1", identifier: "SAM-1", attempt: 2, due_at_ms: 1000, error: "failed", context: "retry context" }],
    completed_issue_ids: ["issue-2"],
    issue_history: [
      {
        issue_id: "issue-1",
        issue_identifier: "SAM-1",
        workspace_path: null,
        restart_count: 1,
        last_error: "failed",
        run_attempts: [
          {
            attempt: 1,
            status: "failed",
            started_at: "2026-05-15T00:00:00.000Z",
            finished_at: "2026-05-15T00:00:04.000Z",
            runtime_seconds: 4,
            workspace_path: "/tmp/workspaces/SAM-1",
            session_id: "thread-turn",
            turn_count: 1,
            error: "failed",
            followup: false
          }
        ],
        recent_events: [{ at: "2026-05-15T00:00:00.000Z", event: "worker_exit_abnormal", issue_id: "issue-1", issue_identifier: "SAM-1", message: "failed" }],
        tracked: { github_pull_request: { number: 1, url: "https://github.test/pr/1", branch: "takt/sam-1", title: "SAM-1", created: true } }
      }
    ],
    recent_events: [{ at: "2026-05-15T00:00:00.000Z", event: "dispatch", issue_id: "issue-1", issue_identifier: "SAM-1" }],
    codex_totals: { input_tokens: 10, output_tokens: 20, total_tokens: 30, seconds_running: 4 },
    codex_rate_limits: { primary: "ok" }
  };
}

function config(root: string): SymphonyConfig {
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
    github: {
      enabled: false,
      owner: null,
      repo: null,
      api_endpoint: "https://api.github.com",
      token: null,
      remote: "origin",
      base_branch: "main",
      branch_prefix: "takt",
      pr_ready_file: "TAKT_PR_READY.json",
      evidence_file: "TAKT_EVIDENCE.json",
      draft: false,
      merge: {
        enabled: false,
        method: "squash",
        require_approval: true,
        require_successful_checks: true,
        require_clean_merge: true,
        delete_branch: true,
        complete_state: null
      }
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      linear_graphql_mcp: { enabled: true, server_name: "takt_linear" }
    },
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
    server: { port: null, host: "127.0.0.1" }
  };
}

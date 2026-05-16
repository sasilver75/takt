import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { GitHubPullRequestMerger } from "./merger.js";

describe("GitHub PR merger", () => {
  test("merges the inspected head SHA and deletes the worker branch", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.method) === "PUT") return jsonResponse({ sha: "merge-sha", merged: true, message: "Pull Request successfully merged" });
      if (String(init?.method) === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ message: "not found" }, 404);
    };
    const merger = new GitHubPullRequestMerger(() => config("/tmp/symphony-gh-merge"), createLogger(() => undefined), fetchImpl);

    const result = await merger.merge({
      pullRequest: {
        number: 42,
        url: "https://github.test/acme/widgets/pull/42",
        branch: "symphony/sam-42-merge-factory-pr",
        title: "SAM-42: Merge factory PR",
        created: false
      },
      inspection: {
        number: 42,
        url: "https://github.test/acme/widgets/pull/42",
        branch: "symphony/sam-42-merge-factory-pr",
        title: "SAM-42: Merge factory PR",
        state: "open",
        checks_status: "success",
        review_status: "approved",
        head_sha: "head-sha",
        mergeable_state: "clean",
        draft: false,
        checked_at: new Date().toISOString(),
        summary: "PR #42 is open; checks=success; review=approved at head-sha.",
        checks: [],
        reviews: [],
        review_comments: []
      }
    });

    expect(result).toEqual({
      number: 42,
      url: "https://github.test/acme/widgets/pull/42",
      merged: true,
      sha: "merge-sha",
      message: "Pull Request successfully merged"
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      body: {
        sha: "head-sha",
        merge_method: "squash",
        commit_title: "SAM-42: Merge factory PR (#42)"
      }
    });
    expect(requests[0]?.url).toBe("https://api.github.test/repos/acme/widgets/pulls/42/merge");
    expect(requests[1]).toMatchObject({ method: "DELETE" });
    expect(requests[1]?.url).toBe("https://api.github.test/repos/acme/widgets/git/refs/heads/symphony/sam-42-merge-factory-pr");
  });
});

function config(root: string): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "linear-secret",
      project_slug: "demo",
      active_states: ["Ready", "In Progress"],
      terminal_states: ["Done"],
      claim_state: "In Progress",
      review_state: "Needs Human"
    },
    github: {
      enabled: true,
      owner: "acme",
      repo: "widgets",
      api_endpoint: "https://api.github.test",
      token: "github-secret-token",
      remote: "origin",
      base_branch: "main",
      branch_prefix: "symphony",
      pr_ready_file: "SYMPHONY_PR_READY.json",
      draft: false,
      merge: {
        enabled: true,
        method: "squash",
        require_approval: true,
        require_successful_checks: true,
        require_clean_merge: true,
        delete_branch: true,
        complete_state: "Done"
      }
    },
    polling: { interval_ms: 1000 },
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
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

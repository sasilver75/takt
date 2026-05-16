import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { classifyCheckRuns, classifyReviews, GitHubPullRequestTracker } from "./tracker.js";

describe("GitHub PR tracker", () => {
  test("classifies failing checks and requested changes with review context", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/pulls/7")) {
        return jsonResponse({
          number: 7,
          html_url: "https://github.test/acme/widgets/pull/7",
          title: "SAM-7: Fix widget",
          state: "open",
          merged: false,
          head: { ref: "symphony/sam-7-fix-widget", sha: "abc123def456" },
          mergeable_state: "clean",
          draft: false
        });
      }
      if (String(url).includes("/check-runs")) {
        return jsonResponse({
          check_runs: [
            { name: "verify", status: "completed", conclusion: "failure", details_url: "https://github.test/checks/1" },
            { name: "lint", status: "completed", conclusion: "success" }
          ]
        });
      }
      if (String(url).endsWith("/commits/abc123def456/status")) {
        return jsonResponse({ statuses: [{ context: "legacy-ci", state: "success", target_url: "https://github.test/status/1" }] });
      }
      if (String(url).endsWith("/pulls/7/reviews?per_page=100")) {
        return jsonResponse([
          {
            user: { login: "reviewer" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-05-15T12:00:00.000Z",
            body: "Please handle the empty state.",
            html_url: "https://github.test/review/1"
          }
        ]);
      }
      if (String(url).endsWith("/pulls/7/comments?per_page=100")) {
        return jsonResponse([
          {
            user: { login: "reviewer" },
            path: "src/widget.ts",
            line: 12,
            body: "This branch misses the null case.",
            html_url: "https://github.test/comment/1"
          }
        ]);
      }
      return jsonResponse({ message: "not found" }, 404);
    };
    const tracker = new GitHubPullRequestTracker(() => config("/tmp/symphony-gh-tracker"), createLogger(() => undefined), fetchImpl);

    const inspection = await tracker.inspect({
      number: 7,
      url: "https://github.test/acme/widgets/pull/7",
      branch: "symphony/sam-7-fix-widget",
      title: "SAM-7: Fix widget",
      created: true
    });

    expect(requests).toHaveLength(5);
    expect(inspection).toMatchObject({
      number: 7,
      state: "open",
      checks_status: "failure",
      review_status: "changes_requested",
      head_sha: "abc123def456",
      reviews: [{ reviewer: "reviewer", state: "CHANGES_REQUESTED" }],
      review_comments: [{ path: "src/widget.ts", line: 12 }]
    });
    expect(inspection.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "verify", conclusion: "failure" })]));
    expect(inspection.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "legacy-ci", conclusion: "success" })]));
  });

  test("classifies pending, successful, and reviewed PR states", () => {
    expect(classifyCheckRuns([{ name: "verify", status: "queued", conclusion: null, details_url: null }])).toBe("pending");
    expect(classifyCheckRuns([{ name: "verify", status: "completed", conclusion: "success", details_url: null }])).toBe("success");
    expect(classifyCheckRuns([])).toBe("unknown");
    expect(classifyReviews([{ reviewer: "sam", state: "APPROVED", submitted_at: null, body: null, url: null }])).toBe("approved");
    expect(
      classifyReviews([
        { reviewer: "sam", state: "CHANGES_REQUESTED", submitted_at: "2026-05-15T12:00:00.000Z", body: null, url: null },
        { reviewer: "sam", state: "COMMENTED", submitted_at: "2026-05-15T12:01:00.000Z", body: null, url: null }
      ])
    ).toBe("changes_requested");
    expect(classifyReviews([])).toBe("review_required");
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
      draft: false
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

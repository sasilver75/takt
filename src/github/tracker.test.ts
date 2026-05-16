import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { classifyCheckRuns, classifyReviews, GitHubPullRequestTracker, inferIssueIdentifier } from "./tracker.js";

describe("GitHub PR tracker", () => {
  test("classifies failing checks and requested changes with review context", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push(`${String(init?.method ?? "GET")} ${String(url)}`);
      if (String(url).endsWith("/graphql")) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/widget.ts",
                      line: 12,
                      comments: {
                        nodes: [
                          {
                            author: { login: "reviewer" },
                            body: "This branch misses the null case.",
                            url: "https://github.test/thread/1",
                            createdAt: "2026-05-15T12:03:00Z",
                            updatedAt: "2026-05-15T12:03:00Z",
                            commit: { oid: "abc123def456" }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        });
      }
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
      if (String(url).endsWith("/issues/7/comments?per_page=100")) {
        return jsonResponse([
          {
            user: { login: "reviewer" },
            body: "Please include reviewer evidence.",
            html_url: "https://github.test/pr-comment/1",
            created_at: "2026-05-15T12:02:00Z",
            updated_at: "2026-05-15T12:02:00Z"
          },
          {
            user: { login: "symphony" },
            body: "<!-- symphony:evidence -->\n## Symphony Worker Evidence",
            html_url: "https://github.test/pr-comment/evidence",
            created_at: "2026-05-15T12:02:30Z",
            updated_at: "2026-05-15T12:02:30Z"
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

    expect(requests).toHaveLength(7);
    expect(inspection).toMatchObject({
      number: 7,
      state: "open",
      checks_status: "failure",
      review_status: "changes_requested",
      head_sha: "abc123def456",
      reviews: [{ reviewer: "reviewer", state: "CHANGES_REQUESTED" }],
      review_comments: [{ path: "src/widget.ts", line: 12 }],
      issue_comments: [{ author: "reviewer", body: "Please include reviewer evidence." }],
      review_threads: [{ id: "thread-1", is_resolved: false, path: "src/widget.ts", line: 12 }]
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

  test("discovers open and recently closed Symphony pull requests and infers Linear issue identifiers", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(String(url));
      if (String(url).includes("/pulls?state=open")) {
        return jsonResponse([
          {
            number: 8,
            html_url: "https://github.test/acme/widgets/pull/8",
            title: "SAM-8: Recover after restart",
            body: "Linear: SAM-8",
            head: { ref: "symphony/sam-8-recover-after-restart" }
          },
          {
            number: 9,
            html_url: "https://github.test/acme/widgets/pull/9",
            title: "Other branch",
            head: { ref: "feature/other" }
          }
        ]);
      }
      if (String(url).includes("/pulls?state=closed")) {
        return jsonResponse([
          {
            number: 10,
            html_url: "https://github.test/acme/widgets/pull/10",
            title: "SAM-10: Human merged while Symphony was offline",
            body: "Linear: SAM-10",
            state: "closed",
            merged_at: "2026-05-16T12:00:00Z",
            head: { ref: "symphony/sam-10-human-merged-while-symphony-was-offline" }
          }
        ]);
      }
      return jsonResponse({ message: "not found" }, 404);
    };
    const tracker = new GitHubPullRequestTracker(() => config("/tmp/symphony-gh-discover"), createLogger(() => undefined), fetchImpl);

    await expect(tracker.discoverManaged({ states: ["open", "closed"] })).resolves.toEqual([
      {
        number: 8,
        url: "https://github.test/acme/widgets/pull/8",
        branch: "symphony/sam-8-recover-after-restart",
        title: "SAM-8: Recover after restart",
        created: false,
        issue_identifier: "SAM-8"
      },
      {
        number: 10,
        url: "https://github.test/acme/widgets/pull/10",
        branch: "symphony/sam-10-human-merged-while-symphony-was-offline",
        title: "SAM-10: Human merged while Symphony was offline",
        created: false,
        issue_identifier: "SAM-10"
      }
    ]);
    expect(requests[0]).toContain("state=open");
    expect(requests[1]).toContain("state=closed");
    expect(requests[0]).toContain("base=main");
    expect(inferIssueIdentifier({ title: "fallback" }, "symphony/abc-12-title", "symphony/")).toBe("ABC-12");
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
      evidence_file: "SYMPHONY_EVIDENCE.json",
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
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
    server: { port: null, host: "127.0.0.1" }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { LinearTrackerClient, normalizeIssue, validateSingleOperation } from "./linear.js";

function config(): SymphonyConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.test/graphql",
      api_key: "secret",
      project_slug: "demo",
      active_states: ["Todo"],
      terminal_states: ["Done"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 1000 },
    workspace: { root: "/tmp/work" },
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

describe("linear tracker", () => {
  test("candidate query uses project slugId filter, active states, and pagination", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [rawIssue({ id: `id-${requests.length}`, identifier: `ABC-${requests.length}` })],
              pageInfo: { hasNextPage: requests.length === 1, endCursor: requests.length === 1 ? "cursor" : null }
            }
          }
        }),
        { status: 200 }
      );
    };
    const client = new LinearTrackerClient(config, fetchImpl as typeof fetch);
    const issues = await client.fetchCandidateIssues();
    expect(issues.map((candidate) => candidate.identifier)).toEqual(["ABC-1", "ABC-2"]);
    expect(requests[0]?.query).toContain("slugId");
    expect(requests[0]?.variables).toMatchObject({ projectSlug: "demo", states: ["Todo"], after: null });
    expect(requests[1]?.variables.after).toBe("cursor");
  });

  test("empty state fetch returns without API call, ID refresh uses ID typing, and identifier recovery queries project", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const client = new LinearTrackerClient(config, (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes("SymphonyIssueStates")) expect(request.query).toContain("$ids: [ID!]");
      if (request.query.includes("SymphonyIssuesByIdentifiers")) {
        expect(request.query).toContain("number");
        expect(request.query).toContain("slugId");
        return new Response(
          JSON.stringify({ data: { issues: { nodes: [rawIssue(), rawIssue({ id: "id-2", identifier: "OTHER-1" })], pageInfo: { hasNextPage: false, endCursor: null } } } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: { issues: { nodes: [rawIssue()] } } }), { status: 200 });
    }) as typeof fetch);
    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
    await expect(client.fetchIssueStatesByIds(["id-1"])).resolves.toHaveLength(1);
    await expect(client.fetchIssuesByIdentifiers(["ABC-1"])).resolves.toHaveLength(1);
    expect(requests[1]?.variables).toMatchObject({ projectSlug: "demo", numbers: [1], after: null });
    await expect(client.fetchIssuesByIdentifiers(["not-an-issue-key"])).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  test("normalizes labels, blockers, priority, and timestamps", () => {
    const normalized = normalizeIssue(
      rawIssue({
        labels: { nodes: [{ name: "Bug" }, { name: "OPS" }] },
        inverseRelations: { nodes: [{ type: "blocks", issue: { id: "b1", identifier: "ABC-0", state: { name: "Todo" } } }] },
        priority: "bad",
        createdAt: "bad"
      })
    );
    expect(normalized.labels).toEqual(["bug", "ops"]);
    expect(normalized.blocked_by).toEqual([{ id: "b1", identifier: "ABC-0", state: "Todo" }]);
    expect(normalized.priority).toBeNull();
    expect(normalized.created_at).toBeNull();
  });

  test("maps Linear errors and validates single-operation linear_graphql tool input", async () => {
    const non200 = new LinearTrackerClient(config, (async () => new Response("no", { status: 500 })) as typeof fetch);
    await expect(non200.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_api_status" });
    const gqlError = new LinearTrackerClient(config, (async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 })) as typeof fetch);
    await expect(gqlError.fetchCandidateIssues()).rejects.toMatchObject({ code: "linear_graphql_errors" });
    expect(() => validateSingleOperation("query A { viewer { id } } mutation B { x }")).toThrow(/exactly one/);
  });

  test("transitions issues by workflow state name and creates comments", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes("SymphonyIssueTeam")) {
        return new Response(JSON.stringify({ data: { issue: { id: "id-1", team: { id: "team-1" } } } }), { status: 200 });
      }
      if (request.query.includes("SymphonyWorkflowState")) {
        expect(request.query).toContain("$teamId: ID!");
        return new Response(JSON.stringify({ data: { workflowStates: { nodes: [{ id: "state-1", name: "Needs Human" }] } } }), { status: 200 });
      }
      if (request.query.includes("SymphonyIssueTransition")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: rawIssue({ state: { name: "Needs Human" } }) } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
    };
    const client = new LinearTrackerClient(config, fetchImpl as typeof fetch);
    await expect(client.transitionIssue(normalizeIssue(rawIssue()), "Needs Human")).resolves.toMatchObject({ state: "Needs Human" });
    await expect(client.commentOnIssue(normalizeIssue(rawIssue()), "Published PR")).resolves.toBeUndefined();
    expect(requests.map((request) => request.variables)).toEqual([
      { id: "id-1" },
      { teamId: "team-1", name: "Needs Human" },
      { id: "id-1", stateId: "state-1" },
      { issueId: "id-1", body: "Published PR" }
    ]);
  });

  test("rejects state transitions when Linear does not return the requested state", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("SymphonyIssueTeam")) {
        return new Response(JSON.stringify({ data: { issue: { id: "id-1", team: { id: "team-1" } } } }), { status: 200 });
      }
      if (request.query.includes("SymphonyWorkflowState")) {
        return new Response(JSON.stringify({ data: { workflowStates: { nodes: [{ id: "state-1", name: "Needs Human" }] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: rawIssue({ state: { name: "In Progress" } }) } } }), { status: 200 });
    };
    const client = new LinearTrackerClient(config, fetchImpl as typeof fetch);
    await expect(client.transitionIssue(normalizeIssue(rawIssue()), "Needs Human")).rejects.toMatchObject({ code: "linear_state_transition_failed" });
  });
});

function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id-1",
    identifier: "ABC-1",
    title: "Title",
    description: null,
    priority: 1,
    branchName: "abc-1",
    url: "https://linear.test/ABC-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    state: { name: "Todo" },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...overrides
  };
}

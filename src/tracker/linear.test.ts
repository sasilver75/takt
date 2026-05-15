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
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 1000 },
    workspace: { root: "/tmp/work" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 1000
    },
    server: { port: null, host: "127.0.0.1" }
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

  test("empty state fetch returns without API call and ID refresh query uses GraphQL ID typing", async () => {
    let called = false;
    const client = new LinearTrackerClient(config, (async (_url: string | URL | Request, init?: RequestInit) => {
      called = true;
      const request = JSON.parse(String(init?.body)) as { query: string };
      expect(request.query).toContain("$ids: [ID!]");
      return new Response(JSON.stringify({ data: { issues: { nodes: [rawIssue()] } } }), { status: 200 });
    }) as typeof fetch);
    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(called).toBe(false);
    await expect(client.fetchIssueStatesByIds(["id-1"])).resolves.toHaveLength(1);
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

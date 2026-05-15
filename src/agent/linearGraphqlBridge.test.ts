import { describe, expect, test } from "vitest";
import type { CodexRuntimeEvent, GraphqlToolExecutor, Issue } from "../domain.js";
import { executeLinearGraphqlBridgeRequest } from "./linearGraphqlBridge.js";

const testIssue: Issue = {
  id: "issue-id",
  identifier: "SAM-1",
  title: "Validate bridge",
  description: null,
  priority: null,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null
};

describe("linear GraphQL loopback bridge", () => {
  test("executes authorized GraphQL requests through the configured executor", async () => {
    const events: CodexRuntimeEvent[] = [];
    const calls: unknown[] = [];
    const executor: GraphqlToolExecutor = {
      async executeGraphql(query, variables) {
        calls.push({ query, variables });
        return { success: true, body: { data: { viewer: { id: "viewer-id" } } } };
      }
    };

    const result = await executeLinearGraphqlBridgeRequest(
      {
        method: "POST",
        pathname: "/linear_graphql",
        authorization: "Bearer bridge-token",
        body: JSON.stringify({ query: "query Viewer { viewer { id } }", variables: { issueId: "issue-id" } })
      },
      "bridge-token",
      {
        executor,
        issue: testIssue,
        projectSlug: "gallatin-demo",
        onEvent: (event) => events.push(event)
      }
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      context: {
        project_slug: "gallatin-demo",
        current_issue_identifier: "SAM-1"
      }
    });
    expect(calls).toEqual([{ query: "query Viewer { viewer { id } }", variables: { issueId: "issue-id" } }]);
    expect(events).toMatchObject([{ event: "linear_graphql_tool_call" }]);
    expect(events[0]?.message).not.toContain("Viewer");
  });

  test("rejects unauthorized and malformed requests before reaching the executor", async () => {
    const executor: GraphqlToolExecutor = {
      async executeGraphql() {
        throw new Error("executor should not be called");
      }
    };
    const options = {
      executor,
      issue: testIssue,
      projectSlug: "gallatin-demo",
      onEvent: () => undefined
    };

    await expect(
      executeLinearGraphqlBridgeRequest(
        { method: "POST", pathname: "/linear_graphql", authorization: "Bearer wrong-token", body: "{}" },
        "bridge-token",
        options
      )
    ).resolves.toMatchObject({ statusCode: 401, body: { success: false } });

    await expect(
      executeLinearGraphqlBridgeRequest(
        { method: "POST", pathname: "/linear_graphql", authorization: "Bearer bridge-token", body: "{\"query\":\"\"}" },
        "bridge-token",
        options
      )
    ).resolves.toMatchObject({ statusCode: 400, body: { success: false, error: "GraphQL query is required" } });
  });
});

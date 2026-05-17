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

describe("linear GraphQL loopback MCP bridge", () => {
  test("serves MCP initialize, tools/list, and linear_graphql calls over HTTP", async () => {
    const events: CodexRuntimeEvent[] = [];
    const calls: unknown[] = [];
    const executor: GraphqlToolExecutor = {
      async executeGraphql(query, variables) {
        calls.push({ query, variables });
        return { success: true, body: { data: { viewer: { id: "viewer-id" } } } };
      }
    };
    const options = {
      executor,
      issue: testIssue,
      projectSlug: "takt",
      onEvent: (event: CodexRuntimeEvent) => events.push(event)
    };

    await expect(
      executeLinearGraphqlBridgeRequest(
        request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
        options
      )
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { id: 1, result: { capabilities: { tools: {} } } }
    });

    await expect(
      executeLinearGraphqlBridgeRequest(request("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), options)
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { id: 2, result: { tools: [{ name: "linear_graphql" }] } }
    });

    const result = await executeLinearGraphqlBridgeRequest(
      request("POST", "/mcp", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "linear_graphql", arguments: { query: "query Viewer { viewer { id } }", variables: { issueId: "issue-id" } } }
      }),
      options
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ id: 3, result: { isError: false } });
    expect(JSON.parse(String(((result.body?.result as any).content[0] as any).text))).toMatchObject({
      success: true,
      context: {
        project_slug: "takt",
        current_issue_identifier: "SAM-1"
      }
    });
    expect(calls).toEqual([{ query: "query Viewer { viewer { id } }", variables: { issueId: "issue-id" } }]);
    expect(events).toMatchObject([{ event: "linear_graphql_tool_call" }]);
    expect(events[0]?.message).not.toContain("Viewer");
  });

  test("rejects malformed requests before reaching the executor", async () => {
    const executor: GraphqlToolExecutor = {
      async executeGraphql() {
        throw new Error("executor should not be called");
      }
    };
    const options = {
      executor,
      issue: testIssue,
      projectSlug: "takt",
      onEvent: () => undefined
    };

    await expect(
      executeLinearGraphqlBridgeRequest(
        {
          method: "POST",
          pathname: "/mcp",
          origin: "https://evil.example",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        },
        options
      )
    ).resolves.toMatchObject({ statusCode: 403, body: { error: { message: "Forbidden origin" } } });

    await expect(
      executeLinearGraphqlBridgeRequest(
        request("POST", "/mcp", {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "linear_graphql", arguments: { query: "" } }
        }),
        options
      )
    ).resolves.toMatchObject({ statusCode: 200, body: { result: { isError: true } } });

    await expect(
      executeLinearGraphqlBridgeRequest(
        request("POST", "/mcp", {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        }),
        options
      )
    ).resolves.toMatchObject({ statusCode: 202, body: null });
  });

  test("requires bearer authorization when a bridge token is configured", async () => {
    const executor: GraphqlToolExecutor = {
      async executeGraphql() {
        return { success: true, body: { ok: true } };
      }
    };
    const options = {
      executor,
      issue: testIssue,
      projectSlug: "takt",
      bearerToken: "bridge-token",
      onEvent: () => undefined
    };

    await expect(
      executeLinearGraphqlBridgeRequest(request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }), options)
    ).resolves.toMatchObject({ statusCode: 401, body: { error: { message: "Unauthorized" } } });

    await expect(
      executeLinearGraphqlBridgeRequest(
        {
          ...request("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
          authorization: "Bearer bridge-token"
        },
        options
      )
    ).resolves.toMatchObject({ statusCode: 200, body: { id: 2, result: { tools: [{ name: "linear_graphql" }] } } });
  });

  test("redacts configured secrets from tool result payloads", async () => {
    const linearSecret = "linear-secret-value";
    const bridgeToken = "bridge-secret-token";
    const executor: GraphqlToolExecutor = {
      async executeGraphql() {
        return {
          success: false,
          error: `transport included ${linearSecret}`,
          body: { authorization: `Bearer ${bridgeToken}` }
        };
      }
    };
    const options = {
      executor,
      issue: testIssue,
      projectSlug: "takt",
      bearerToken: bridgeToken,
      secretValues: [linearSecret],
      onEvent: () => undefined
    };

    const result = await executeLinearGraphqlBridgeRequest(
      {
        ...request("POST", "/mcp", {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "linear_graphql", arguments: { query: "query Viewer { viewer { id } }" } }
        }),
        authorization: `Bearer ${bridgeToken}`
      },
      options
    );

    const text = String(((result.body?.result as any).content[0] as any).text);
    expect(text).not.toContain(linearSecret);
    expect(text).not.toContain(bridgeToken);
    expect(text).toContain("[redacted]");
    expect(text).toContain("transport included");
  });
});

function request(method: string, pathname: string, body: unknown) {
  return {
    method,
    pathname,
    origin: null,
    body: JSON.stringify(body)
  };
}

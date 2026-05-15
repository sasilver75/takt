import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Issue, SymphonyConfig } from "../domain.js";
import { appendMcpConfig, prepareLinearGraphqlMcp, sanitizedCodexEnv } from "./linearGraphqlMcp.js";

describe("linear GraphQL MCP launch config", () => {
  test("appends a hosted Codex MCP server URL without embedding capabilities", () => {
    const command = appendMcpConfig("codex app-server", "symphony_linear", "http://127.0.0.1:1234/mcp");
    expect(command).toContain("mcp_servers.symphony_linear.url");
    expect(command).toContain("http://127.0.0.1:1234/mcp");
    expect(command).not.toContain("mcp_servers.symphony_linear.args");
    expect(command).not.toContain("LINEAR_API_KEY");
    expect(command).not.toContain("test-capability-token");
  });

  test("prepares hosted MCP config without writing token-bearing workspace files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-"));
    const launch = await prepareLinearGraphqlMcp(
      config(),
      workspace,
      issue(),
      { url: "http://127.0.0.1:1234/mcp", token: "test-capability-token" }
    );

    expect(launch.command).toContain("mcp_servers.symphony_linear.url");
    expect(launch.command).not.toContain("test-capability-token");
    expect(launch.configuredUrl).toBe("http://127.0.0.1:1234/mcp");
    expect(await readdir(workspace)).toEqual([]);
    expect(launch.env.LINEAR_API_KEY).toBeUndefined();
    expect(Object.values(launch.env)).not.toContain("local-secret");
  });

  test("sanitizes secret-looking app-server environment variables", () => {
    const env = sanitizedCodexEnv(
      {
        PATH: "/usr/bin",
        LINEAR_API_KEY: "local-secret",
        GITHUB_TOKEN: "github-secret",
        NORMAL_FLAG: "1",
        WRAPPED: "before-local-secret-after"
      },
      config(),
      { SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER: "SAM-1" }
    );

    expect(env).toMatchObject({ PATH: "/usr/bin", NORMAL_FLAG: "1", SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER: "SAM-1" });
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.WRAPPED).toBeUndefined();
  });
});

function config(): SymphonyConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "local-secret",
      project_slug: "demo",
      active_states: ["Todo"],
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60_000
    },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
      max_retry_backoff_ms: 60_000,
      max_concurrent_agents_by_state: {}
    },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 60_000,
      read_timeout_ms: 1_000,
      stall_timeout_ms: 1_000,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

function issue(): Issue {
  return {
    id: "issue-id",
    identifier: "SAM-1",
    title: "Test",
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
}

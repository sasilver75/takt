import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendMcpConfig, linearGraphqlMcpServerSource } from "./linearGraphqlMcp.js";

describe("linear GraphQL MCP bridge", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGTERM");
  });

  test("appends a Codex MCP server config without embedding credentials", () => {
    const command = appendMcpConfig("codex app-server", "symphony_linear", "/tmp/work/.symphony/linear-graphql-mcp.mjs");
    expect(command).toContain("mcp_servers.symphony_linear.command");
    expect(command).toContain("mcp_servers.symphony_linear.args");
    expect(command).toContain("/tmp/work/.symphony/linear-graphql-mcp.mjs");
    expect(command).not.toContain("LINEAR_API_KEY");
  });

  test("serves linear_graphql over MCP stdio and fails closed without auth", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-"));
    const scriptPath = path.join(temp, "linear-graphql-mcp.mjs");
    await writeFile(scriptPath, linearGraphqlMcpServerSource(), { mode: 0o700 });
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        SYMPHONY_LINEAR_API_KEY: "",
        LINEAR_API_KEY: "",
        SYMPHONY_LINEAR_ENDPOINT: "https://api.linear.invalid/graphql",
        SYMPHONY_LINEAR_PROJECT_SLUG: "demo",
        SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER: "SAM-1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child);
    const responses = createResponseReader(child);

    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(await responses.next()).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(await responses.next()).toMatchObject({ id: 2, result: { tools: [{ name: "linear_graphql" }] } });

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "linear_graphql", arguments: { query: "query Viewer { viewer { id } }", variables: { issueId: "SAM-1" } } }
    });
    const toolResult = await responses.next();
    expect(toolResult).toMatchObject({ id: 3, result: { isError: true } });
    expect(JSON.parse(toolResult.result.content[0].text)).toMatchObject({
      success: false,
      error: "Linear API key is unavailable to Symphony MCP server"
    });
  });
});

function send(child: ChildProcessWithoutNullStreams, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function createResponseReader(child: ChildProcessWithoutNullStreams): { next: () => Promise<any> } {
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const value = queue.shift();
        if (value) resolve(value);
        else waiters.push(resolve);
      })
  };
}

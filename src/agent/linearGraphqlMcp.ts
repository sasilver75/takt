import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Issue, SymphonyConfig } from "../domain.js";

const SCRIPT_DIR = ".symphony";
const SCRIPT_FILE = "linear-graphql-mcp.mjs";

export type LinearGraphqlMcpBridgeConfig = {
  url: string;
  token: string;
};

export type LinearMcpLaunch = {
  command: string;
  env: NodeJS.ProcessEnv;
  scriptPath: string | null;
};

export async function prepareLinearGraphqlMcp(
  config: SymphonyConfig,
  workspacePath: string,
  issue: Issue | null,
  bridge: LinearGraphqlMcpBridgeConfig | null
): Promise<LinearMcpLaunch> {
  if (!config.codex.linear_graphql_mcp.enabled) {
    return { command: config.codex.command, env: process.env, scriptPath: null };
  }
  const scriptPath = path.join(workspacePath, SCRIPT_DIR, SCRIPT_FILE);
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, linearGraphqlMcpServerSource(bridge, config, issue), { mode: 0o700 });
  return {
    command: appendMcpConfig(config.codex.command, config.codex.linear_graphql_mcp.server_name, scriptPath),
    env: {
      ...process.env,
      SYMPHONY_LINEAR_PROJECT_SLUG: config.tracker.project_slug ?? "",
      SYMPHONY_LINEAR_CURRENT_ISSUE_ID: issue?.id ?? "",
      SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER: issue?.identifier ?? ""
    },
    scriptPath
  };
}

export function appendMcpConfig(command: string, serverName: string, scriptPath: string): string {
  const commandConfig = `mcp_servers.${serverName}.command="node"`;
  const argsConfig = `mcp_servers.${serverName}.args=${tomlStringArray([scriptPath])}`;
  return `${command} -c ${shellQuote(commandConfig)} -c ${shellQuote(argsConfig)}`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function linearGraphqlMcpServerSource(
  bridge: LinearGraphqlMcpBridgeConfig | null = null,
  config: Pick<SymphonyConfig, "tracker"> | null = null,
  issue: Issue | null = null
): string {
  return `#!/usr/bin/env node
import { createInterface } from "node:readline";

const DEFAULT_BRIDGE_URL = ${JSON.stringify(bridge?.url ?? "")};
const DEFAULT_BRIDGE_TOKEN = ${JSON.stringify(bridge?.token ?? "")};
const DEFAULT_PROJECT_SLUG = ${JSON.stringify(config?.tracker.project_slug ?? "")};
const DEFAULT_CURRENT_ISSUE_ID = ${JSON.stringify(issue?.id ?? "")};
const DEFAULT_CURRENT_ISSUE_IDENTIFIER = ${JSON.stringify(issue?.identifier ?? "")};
const BRIDGE_URL = process.env.SYMPHONY_LINEAR_BRIDGE_URL || DEFAULT_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.SYMPHONY_LINEAR_BRIDGE_TOKEN || DEFAULT_BRIDGE_TOKEN;
const PROJECT_SLUG = process.env.SYMPHONY_LINEAR_PROJECT_SLUG || DEFAULT_PROJECT_SLUG;
const CURRENT_ISSUE_ID = process.env.SYMPHONY_LINEAR_CURRENT_ISSUE_ID || DEFAULT_CURRENT_ISSUE_ID;
const CURRENT_ISSUE_IDENTIFIER = process.env.SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER || DEFAULT_CURRENT_ISSUE_IDENTIFIER;

const TOOL = {
  name: "linear_graphql",
  description: [
    "Execute exactly one Linear GraphQL query or mutation using Symphony's configured tracker credential.",
    "Use this for Linear issue comments, state transitions, project-scoped reads, and handoff updates.",
    "Do not read Linear tokens from disk."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "A single Linear GraphQL query or mutation document."
      },
      variables: {
        type: "object",
        description: "Optional GraphQL variables object.",
        additionalProperties: true
      }
    }
  },
  annotations: {
    title: "Linear GraphQL",
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false
  }
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeError(null, -32700, "Parse error", String(error?.message || error));
    return;
  }
  void handleMessage(message).catch((error) => {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      writeError(message.id, -32603, String(error?.message || error));
    }
  });
});

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const method = message.method;
  if (method === "notifications/initialized") return;
  if (id === undefined) return;
  if (method === "initialize") {
    writeResult(id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "symphony-linear", version: "0.1.0" }
    });
    return;
  }
  if (method === "ping") {
    writeResult(id, {});
    return;
  }
  if (method === "tools/list") {
    writeResult(id, { tools: [TOOL] });
    return;
  }
  if (method === "tools/call") {
    const result = await callTool(message.params || {});
    writeResult(id, result);
    return;
  }
  if (method === "resources/list" || method === "prompts/list") {
    writeResult(id, method === "resources/list" ? { resources: [] } : { prompts: [] });
    return;
  }
  writeError(id, -32601, "Method not found");
}

async function callTool(params) {
  if (params.name !== "linear_graphql") {
    return toolResult({ success: false, error: "Unsupported tool: " + String(params.name || "") }, true);
  }
  const args = params.arguments || {};
  const query = typeof args === "string" ? args : args.query;
  const variables = typeof args === "object" && args.variables && typeof args.variables === "object" && !Array.isArray(args.variables) ? args.variables : {};
  if (typeof query !== "string" || !query.trim()) {
    return toolResult({ success: false, error: "linear_graphql query is required" }, true);
  }
  const validation = validateSingleOperation(query);
  if (validation) return toolResult({ success: false, error: validation }, true);
  if (!BRIDGE_URL || !BRIDGE_TOKEN) return toolResult({ success: false, error: "Symphony Linear GraphQL bridge is unavailable" }, true);

  const started = Date.now();
  try {
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + BRIDGE_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      audit({ success: false, duration_ms: Date.now() - started });
      return toolResult({ success: false, error: bridgeError(body, response.status), context: contextPayload() }, true);
    }
    const success = Boolean(body && typeof body === "object" && body.success);
    audit({ success, duration_ms: Date.now() - started });
    return toolResult(body && typeof body === "object" ? body : { success: false, error: "Symphony Linear bridge returned invalid JSON", context: contextPayload() }, !success);
  } catch (error) {
    audit({ success: false, duration_ms: Date.now() - started });
    return toolResult({ success: false, error: String(error?.message || error), context: contextPayload() }, true);
  }
}

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError
  };
}

function validateSingleOperation(query) {
  const stripped = query.replace(/#[^\\n]*/g, "").replace(/"([^"\\\\]|\\\\.)*"/g, "\\\"\\\"");
  const operations = stripped.match(/\\b(query|mutation|subscription)\\b/g) || [];
  if (!query.trim()) return "GraphQL query is required";
  if (operations.length > 1) return "linear_graphql accepts exactly one GraphQL operation";
  return null;
}

function contextPayload() {
  return {
    project_slug: PROJECT_SLUG || null,
    current_issue_id: CURRENT_ISSUE_ID || null,
    current_issue_identifier: CURRENT_ISSUE_IDENTIFIER || null
  };
}

function bridgeError(body, status) {
  if (body && typeof body === "object" && typeof body.error === "string") return body.error;
  return "Symphony Linear bridge returned HTTP " + status;
}

function audit(event) {
  process.stderr.write(JSON.stringify({
    source: "symphony_linear_mcp",
    tool: "linear_graphql",
    success: event.success,
    duration_ms: event.duration_ms,
    project_slug: PROJECT_SLUG || null,
    issue_identifier: CURRENT_ISSUE_IDENTIFIER || null
  }) + "\\n");
}

function writeResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function writeError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\\n");
}
`;
}

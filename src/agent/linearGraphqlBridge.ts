import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexRuntimeEvent, GraphqlToolExecutor, Issue } from "../domain.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { validateSingleOperation } from "../tracker/linear.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MCP_ENDPOINT = "/mcp";
const TOOL = {
  name: "linear_graphql",
  description: [
    "Execute exactly one Linear GraphQL query or mutation using Takt's configured tracker credential.",
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

export type LinearGraphqlBridgeHandle = {
  url: string;
  token?: string | undefined;
  close(): Promise<void>;
};

export type LinearGraphqlBridgeStartOptions = {
  executor: GraphqlToolExecutor | null | undefined;
  issue: Issue;
  projectSlug: string | null;
  bindHost?: string | undefined;
  publicHost?: string | undefined;
  bearerToken?: string | null | undefined;
  logger: Logger;
  onEvent: (event: CodexRuntimeEvent) => void;
  maxBodyBytes?: number;
};

export type LinearGraphqlBridgeRequest = {
  method: string;
  pathname: string;
  origin: string | null;
  authorization?: string | null | undefined;
  body: string;
};

export type LinearGraphqlBridgeResponse = {
  statusCode: number;
  body: Record<string, unknown> | null;
};

export async function startLinearGraphqlBridge(options: LinearGraphqlBridgeStartOptions): Promise<LinearGraphqlBridgeHandle | null> {
  if (!options.executor) return null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const bindHost = options.bindHost ?? "127.0.0.1";
  const publicHost = options.publicHost ?? bindHost;
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, maxBodyBytes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    server.close();
    throw new Error("Linear GraphQL bridge did not bind to a TCP port");
  }
  const url = `http://${publicHost}:${address.port}${MCP_ENDPOINT}`;
  options.logger.info("linear graphql mcp bridge started", { issue_identifier: options.issue.identifier, bridge_url: url });
  options.onEvent({
    event: "linear_graphql_bridge_started",
    timestamp: new Date().toISOString(),
    message: options.bearerToken ? "authenticated mcp bridge ready" : "loopback mcp bridge ready"
  });

  return {
    url,
    ...(options.bearerToken ? { token: options.bearerToken } : {}),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

export async function executeLinearGraphqlBridgeRequest(
  request: LinearGraphqlBridgeRequest,
  options: Pick<LinearGraphqlBridgeStartOptions, "executor" | "issue" | "projectSlug" | "onEvent" | "bearerToken">
): Promise<LinearGraphqlBridgeResponse> {
  if (request.pathname !== MCP_ENDPOINT) return response(404, rpcError(null, -32004, "Not found"));
  if (!isAllowedOrigin(request.origin)) return response(403, rpcError(null, -32003, "Forbidden origin"));
  if (!isAllowedAuthorization(request.authorization ?? null, options.bearerToken ?? null)) {
    return response(401, rpcError(null, -32001, "Unauthorized"));
  }
  if (request.method === "GET" || request.method === "DELETE") return response(405, rpcError(null, -32005, "Method not allowed"));
  if (request.method !== "POST") return response(405, rpcError(null, -32005, "Method not allowed"));
  let payload: unknown;
  try {
    payload = JSON.parse(request.body);
  } catch {
    return response(400, rpcError(null, -32700, "Parse error"));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response(400, rpcError(null, -32600, "Invalid Request"));
  }
  const message = payload as Record<string, unknown>;
  if (message.id === undefined) {
    if (typeof message.method === "string" || message.result !== undefined || message.error !== undefined) return response(202, null);
    return response(400, rpcError(null, -32600, "Invalid Request"));
  }
  const result = await handleMcpRequest(message, options);
  return response(200, result);
}

async function handleMcpRequest(
  message: Record<string, unknown>,
  options: Pick<LinearGraphqlBridgeStartOptions, "executor" | "issue" | "projectSlug" | "onEvent">
): Promise<Record<string, unknown>> {
  const id = message.id;
  const method = message.method;
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: protocolVersion(message),
      capabilities: { tools: {} },
      serverInfo: { name: "takt-linear", version: "0.1.0" }
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: [TOOL] });
  if (method === "tools/call") return rpcResult(id, await callTool(objectAt(message, "params"), options));
  if (method === "resources/list") return rpcResult(id, { resources: [] });
  if (method === "prompts/list") return rpcResult(id, { prompts: [] });
  return rpcError(id, -32601, "Method not found");
}

async function callTool(
  params: Record<string, unknown>,
  options: Pick<LinearGraphqlBridgeStartOptions, "executor" | "issue" | "projectSlug" | "onEvent">
): Promise<Record<string, unknown>> {
  if (params.name !== "linear_graphql") {
    return toolResult({ success: false, error: `Unsupported tool: ${String(params.name || "")}` }, true);
  }
  if (!options.executor) return toolResult({ success: false, error: "Linear GraphQL executor is unavailable" }, true);
  const args = params.arguments;
  const query = typeof args === "string" ? args : objectAt(params, "arguments").query;
  const variables = typeof args === "object" && args && !Array.isArray(args) ? objectAt(args as Record<string, unknown>, "variables") : {};
  if (typeof query !== "string" || !query.trim()) {
    return toolResult({ success: false, error: "linear_graphql query is required", context: contextPayload(options) }, true);
  }
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return toolResult({ success: false, error: "linear_graphql variables must be an object", context: contextPayload(options) }, true);
  }
  try {
    validateSingleOperation(query);
  } catch (error) {
    return toolResult({ success: false, error: errorMessage(error), context: contextPayload(options) }, true);
  }

  const started = Date.now();
  const result = await options.executor.executeGraphql(query, variables);
  options.onEvent({
    event: "linear_graphql_tool_call",
    timestamp: new Date().toISOString(),
    message: `mcp_http success=${result.success} duration_ms=${Date.now() - started}`
  });
  return toolResult({
    ...result,
    context: contextPayload(options)
  }, !result.success);
}

function contextPayload(options: Pick<LinearGraphqlBridgeStartOptions, "issue" | "projectSlug">): Record<string, string | null> {
  return {
    project_slug: options.projectSlug,
    current_issue_id: options.issue.id,
    current_issue_identifier: options.issue.identifier
  };
}

function toolResult(payload: Record<string, unknown>, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  responseWriter: ServerResponse,
  options: LinearGraphqlBridgeStartOptions,
  maxBodyBytes: number
): Promise<void> {
  try {
    const requestBody = await readBody(request, maxBodyBytes);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const result = await executeLinearGraphqlBridgeRequest(
      {
        method: request.method ?? "GET",
        pathname: url.pathname,
        origin: request.headers.origin ?? null,
        authorization: request.headers.authorization ?? null,
        body: requestBody
      },
      options
    );
    writeJson(responseWriter, result.statusCode, result.body);
  } catch (error) {
    const statusCode = error instanceof BodyTooLargeError ? 413 : 500;
    const message = error instanceof BodyTooLargeError ? "Request body is too large" : "Linear GraphQL bridge failed";
    options.logger.warn("linear graphql bridge request failed", {
      issue_identifier: options.issue.identifier,
      error: errorMessage(error)
    });
    writeJson(responseWriter, statusCode, rpcError(null, -32603, message));
  }
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        reject(new BodyTooLargeError());
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function response(statusCode: number, body: Record<string, unknown> | null): LinearGraphqlBridgeResponse {
  return { statusCode, body };
}

function writeJson(responseWriter: ServerResponse, statusCode: number, body: Record<string, unknown> | null): void {
  if (body === null) {
    responseWriter.writeHead(statusCode);
    responseWriter.end();
    return;
  }
  responseWriter.writeHead(statusCode, { "content-type": "application/json" });
  responseWriter.end(JSON.stringify(body));
}

function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function protocolVersion(message: Record<string, unknown>): string {
  const params = objectAt(message, "params");
  return typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1", "host.docker.internal"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedAuthorization(header: string | null, bearerToken: string | null): boolean {
  if (!bearerToken) return true;
  return header === `Bearer ${bearerToken}`;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
  }
}

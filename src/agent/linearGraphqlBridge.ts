import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexRuntimeEvent, GraphqlToolExecutor, Issue } from "../domain.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type LinearGraphqlBridgeHandle = {
  url: string;
  token: string;
  close(): Promise<void>;
};

export type LinearGraphqlBridgeStartOptions = {
  executor: GraphqlToolExecutor | null | undefined;
  issue: Issue;
  projectSlug: string | null;
  logger: Logger;
  onEvent: (event: CodexRuntimeEvent) => void;
  maxBodyBytes?: number;
};

export type LinearGraphqlBridgeRequest = {
  method: string;
  pathname: string;
  authorization: string | null;
  body: string;
};

export type LinearGraphqlBridgeResponse = {
  statusCode: number;
  body: Record<string, unknown>;
};

export async function startLinearGraphqlBridge(options: LinearGraphqlBridgeStartOptions): Promise<LinearGraphqlBridgeHandle | null> {
  if (!options.executor) return null;
  const token = randomBytes(32).toString("base64url");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, token, options, maxBodyBytes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    server.close();
    throw new Error("Linear GraphQL bridge did not bind to a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}/linear_graphql`;
  options.logger.info("linear graphql bridge started", { issue_identifier: options.issue.identifier, bridge_url: url });
  options.onEvent({
    event: "linear_graphql_bridge_started",
    timestamp: new Date().toISOString(),
    message: "loopback bridge ready"
  });

  return {
    url,
    token,
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
  token: string,
  options: Pick<LinearGraphqlBridgeStartOptions, "executor" | "issue" | "projectSlug" | "onEvent">
): Promise<LinearGraphqlBridgeResponse> {
  if (request.pathname !== "/linear_graphql") return response(404, { success: false, error: "Not found" });
  if (request.method !== "POST") return response(405, { success: false, error: "Method not allowed" });
  if (!isAuthorized(request.authorization, token)) return response(401, { success: false, error: "Unauthorized" });
  if (!options.executor) return response(503, { success: false, error: "Linear GraphQL executor is unavailable" });

  let payload: unknown;
  try {
    payload = JSON.parse(request.body);
  } catch {
    return response(400, { success: false, error: "Request body must be JSON" });
  }
  if (!payload || typeof payload !== "object") return response(400, { success: false, error: "Request body must be an object" });
  const data = payload as Record<string, unknown>;
  const query = data.query;
  const variables = data.variables ?? {};
  if (typeof query !== "string" || !query.trim()) return response(400, { success: false, error: "GraphQL query is required" });
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return response(400, { success: false, error: "GraphQL variables must be an object" });
  }

  const started = Date.now();
  const result = await options.executor.executeGraphql(query, variables as Record<string, unknown>);
  options.onEvent({
    event: "linear_graphql_tool_call",
    timestamp: new Date().toISOString(),
    message: `bridge success=${result.success} duration_ms=${Date.now() - started}`
  });
  return response(200, {
    ...result,
    context: {
      project_slug: options.projectSlug,
      current_issue_id: options.issue.id,
      current_issue_identifier: options.issue.identifier
    }
  });
}

async function handleHttpRequest(
  request: IncomingMessage,
  responseWriter: ServerResponse,
  token: string,
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
        authorization: request.headers.authorization ?? null,
        body: requestBody
      },
      token,
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
    writeJson(responseWriter, statusCode, { success: false, error: message });
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

function response(statusCode: number, body: Record<string, unknown>): LinearGraphqlBridgeResponse {
  return { statusCode, body };
}

function writeJson(responseWriter: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  responseWriter.writeHead(statusCode, { "content-type": "application/json" });
  responseWriter.end(JSON.stringify(body));
}

function isAuthorized(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length);
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
  }
}

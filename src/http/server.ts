import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Logger } from "../observability/logger.js";

export type HttpStatusServer = {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
};

export function createHttpStatusServer(options: {
  host: string;
  port: number;
  orchestrator: Orchestrator;
  logger: Logger;
}): HttpStatusServer {
  const server = http.createServer((request, response) => {
    void route(request, response, options.orchestrator).catch((error: unknown) => {
      options.logger.error("http route failed", { error: error instanceof Error ? error.message : String(error) });
      writeJson(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
    });
  });
  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          options.logger.info("http status server started", { host: address.address, port: address.port });
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function route(request: IncomingMessage, response: ServerResponse, orchestrator: Orchestrator): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    if (request.method !== "GET") return methodNotAllowed(response);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboard(orchestrator.snapshot()));
    return;
  }
  if (url.pathname === "/api/v1/state") {
    if (request.method !== "GET") return methodNotAllowed(response);
    return writeJson(response, 200, orchestrator.snapshot());
  }
  if (url.pathname === "/api/v1/refresh") {
    if (request.method !== "POST") return methodNotAllowed(response);
    const result = orchestrator.queueImmediateTick();
    return writeJson(response, 202, {
      ...result,
      requested_at: new Date().toISOString(),
      operations: ["poll", "reconcile"]
    });
  }
  const issueMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
  if (issueMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const identifier = decodeURIComponent(issueMatch[1] ?? "");
    const snapshot = orchestrator.issueSnapshot(identifier);
    if (!snapshot) return writeJson(response, 404, { error: { code: "issue_not_found", message: `Issue ${identifier} is not tracked` } });
    return writeJson(response, 200, snapshot);
  }
  return writeJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
}

function methodNotAllowed(response: ServerResponse): void {
  writeJson(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function renderDashboard(snapshot: unknown): string {
  const state = snapshot as {
    counts?: { running?: number; retrying?: number; completed?: number; pull_requests?: number };
    codex_totals?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; seconds_running?: number };
    running?: Array<{ issue_identifier: string; state: string; last_event: string | null; turn_count: number }>;
    retrying?: Array<{ issue_identifier: string; attempt: number; due_at: string; error: string | null }>;
    pull_requests?: Array<{
      issue_identifier: string;
      pull_request: { number: number; url: string };
      status: { state?: string; checks_status?: string; review_status?: string; summary?: string } | null;
    }>;
  };
  const runningRows = (state.running ?? [])
    .map((row) => `<tr><td>${escapeHtml(row.issue_identifier)}</td><td>${escapeHtml(row.state)}</td><td>${row.turn_count}</td><td>${escapeHtml(row.last_event ?? "")}</td></tr>`)
    .join("");
  const retryRows = (state.retrying ?? [])
    .map((row) => `<tr><td>${escapeHtml(row.issue_identifier)}</td><td>${row.attempt}</td><td>${escapeHtml(row.due_at)}</td><td>${escapeHtml(row.error ?? "")}</td></tr>`)
    .join("");
  const prRows = (state.pull_requests ?? [])
    .map((row) => {
      const status = row.status;
      return `<tr><td>${escapeHtml(row.issue_identifier)}</td><td><a href="${escapeHtml(row.pull_request.url)}">#${row.pull_request.number}</a></td><td>${escapeHtml(status?.state ?? "")}</td><td>${escapeHtml(status?.checks_status ?? "")}</td><td>${escapeHtml(status?.review_status ?? "")}</td><td>${escapeHtml(status?.summary ?? "")}</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Status</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f7f7f4;color:#1e2528}
    header{background:#172026;color:#fff;padding:24px 32px}
    main{padding:24px 32px;display:grid;gap:24px}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
    .metric,section{background:#fff;border:1px solid #d9ded8;border-radius:8px;padding:16px}
    .value{font-size:28px;font-weight:700}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;border-bottom:1px solid #e3e6e1;padding:10px;font-size:14px}
    th{color:#5c666b}
  </style>
</head>
<body>
  <header><h1>Symphony Status</h1></header>
  <main>
    <div class="metrics">
      <div class="metric"><div>Running</div><div class="value">${state.counts?.running ?? 0}</div></div>
      <div class="metric"><div>Retrying</div><div class="value">${state.counts?.retrying ?? 0}</div></div>
      <div class="metric"><div>Completed</div><div class="value">${state.counts?.completed ?? 0}</div></div>
      <div class="metric"><div>Pull Requests</div><div class="value">${state.counts?.pull_requests ?? 0}</div></div>
      <div class="metric"><div>Total Tokens</div><div class="value">${state.codex_totals?.total_tokens ?? 0}</div></div>
      <div class="metric"><div>Runtime Seconds</div><div class="value">${Math.round(state.codex_totals?.seconds_running ?? 0)}</div></div>
    </div>
    <section><h2>Running</h2><table><thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th></tr></thead><tbody>${runningRows}</tbody></table></section>
    <section><h2>Retry Queue</h2><table><thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr></thead><tbody>${retryRows}</tbody></table></section>
    <section><h2>Pull Requests</h2><table><thead><tr><th>Issue</th><th>PR</th><th>State</th><th>Checks</th><th>Review</th><th>Summary</th></tr></thead><tbody>${prRows}</tbody></table></section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

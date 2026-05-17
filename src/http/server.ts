import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { EvidenceManifest } from "../domain.js";
import { isDurableEvidenceArtifactPath, localEvidenceArtifactFiles, localEvidenceArtifactScan, normalizeEvidenceArtifactPath } from "../github/evidenceArtifacts.js";
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
  const artifactListMatch = /^\/api\/v1\/([^/]+)\/artifacts$/.exec(url.pathname);
  if (artifactListMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const identifier = decodeURIComponent(artifactListMatch[1] ?? "");
    const snapshot = orchestrator.issueSnapshot(identifier);
    if (!snapshot) return writeJson(response, 404, { error: { code: "issue_not_found", message: `Issue ${identifier} is not tracked` } });
    return writeJson(response, 200, await artifactListSnapshot(snapshot));
  }
  const artifactFileMatch = /^\/artifacts\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (artifactFileMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const identifier = decodeURIComponent(artifactFileMatch[1] ?? "");
    const requestedPath = decodeURIComponent(artifactFileMatch[2] ?? "");
    const snapshot = orchestrator.issueSnapshot(identifier);
    if (!snapshot) return writeJson(response, 404, { error: { code: "issue_not_found", message: `Issue ${identifier} is not tracked` } });
    return serveEvidenceArtifact(response, snapshot, requestedPath);
  }
  const issuePageMatch = /^\/issues\/([^/]+)$/.exec(url.pathname);
  if (issuePageMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const identifier = decodeURIComponent(issuePageMatch[1] ?? "");
    const snapshot = orchestrator.issueSnapshot(identifier);
    if (!snapshot) return writeJson(response, 404, { error: { code: "issue_not_found", message: `Issue ${identifier} is not tracked` } });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderIssuePage(snapshot));
    return;
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
    recent_events?: Array<{ at: string; event: string; issue_identifier?: string; session_id?: string | null; message?: string | null }>;
    pull_requests?: Array<{
      issue_identifier: string;
      pull_request: { number: number; url: string };
      status: { state?: string; checks_status?: string; review_status?: string; summary?: string } | null;
      evidence?: {
        comment_url?: string | null;
        last_error?: string | null;
        warnings?: string[];
        manifest?: {
          artifacts?: unknown[];
          app_urls?: string[];
          verification?: string[];
          commands?: unknown[];
        } | null;
      } | null;
    }>;
  };
  const runningRows = (state.running ?? [])
    .map((row) => `<tr><td>${issueDrilldownLink(row.issue_identifier)}</td><td>${escapeHtml(row.state)}</td><td>${row.turn_count}</td><td>${escapeHtml(row.last_event ?? "")}</td></tr>`)
    .join("");
  const retryRows = (state.retrying ?? [])
    .map((row) => `<tr><td>${issueDrilldownLink(row.issue_identifier)}</td><td>${row.attempt}</td><td>${escapeHtml(row.due_at)}</td><td>${escapeHtml(row.error ?? "")}</td></tr>`)
    .join("");
  const prRows = (state.pull_requests ?? [])
    .map((row) => {
      const status = row.status;
      return `<tr><td>${issueDrilldownLink(row.issue_identifier)}</td><td><a href="${escapeHtml(row.pull_request.url)}">#${row.pull_request.number}</a></td><td>${escapeHtml(status?.state ?? "")}</td><td>${escapeHtml(status?.checks_status ?? "")}</td><td>${escapeHtml(status?.review_status ?? "")}</td><td>${renderEvidenceCell(row.evidence ?? null)}</td><td>${escapeHtml(status?.summary ?? "")}</td></tr>`;
    })
    .join("");
  const eventRows = (state.recent_events ?? [])
    .slice(-50)
    .reverse()
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.at)}</td><td>${escapeHtml(row.event)}</td><td>${row.issue_identifier ? issueDrilldownLink(row.issue_identifier) : ""}</td><td>${escapeHtml(row.session_id ?? "")}</td><td>${escapeHtml(row.message ?? "")}</td></tr>`
    )
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
    <section><h2>Pull Requests</h2><table><thead><tr><th>Issue</th><th>PR</th><th>State</th><th>Checks</th><th>Review</th><th>Evidence</th><th>Summary</th></tr></thead><tbody>${prRows}</tbody></table></section>
    <section><h2>Recent Events</h2><table><thead><tr><th>Time</th><th>Event</th><th>Issue</th><th>Session</th><th>Message</th></tr></thead><tbody>${eventRows}</tbody></table></section>
  </main>
</body>
</html>`;
}

function issueDrilldownLink(identifier: string): string {
  return `<a href="/issues/${encodeURIComponent(identifier)}">${escapeHtml(identifier)}</a>`;
}

function issueApiLink(identifier: string): string {
  return `/api/v1/${encodeURIComponent(identifier)}`;
}

function renderIssuePage(snapshot: unknown): string {
  const issue = snapshot as IssuePageSnapshot;
  const tracked = issue.tracked ?? {};
  const pullRequest = readObject(tracked.github_pull_request);
  const pullRequestStatus = readObject(tracked.github_pull_request_status);
  const evidence = readObject(tracked.github_evidence_manifest);
  const recentEvents = issue.recent_events ?? [];
  const eventRows = recentEvents
    .slice(-100)
    .reverse()
    .map((row) => `<tr><td>${escapeHtml(row.at ?? "")}</td><td>${escapeHtml(row.event ?? "")}</td><td>${escapeHtml(row.session_id ?? "")}</td><td>${escapeHtml(row.message ?? "")}</td></tr>`)
    .join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Issue ${escapeHtml(issue.issue_identifier ?? "")}</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f7f7f4;color:#1e2528}
    header{background:#172026;color:#fff;padding:24px 32px}
    main{padding:24px 32px;display:grid;gap:24px}
    nav a{color:#dce7ec;margin-right:16px}
    section{background:#fff;border:1px solid #d9ded8;border-radius:8px;padding:16px;overflow:auto}
    dl{display:grid;grid-template-columns:minmax(120px,220px) 1fr;gap:8px 16px;margin:0}
    dt{color:#5c666b;font-weight:600}
    dd{margin:0;overflow-wrap:anywhere}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;border-bottom:1px solid #e3e6e1;padding:10px;font-size:14px;vertical-align:top}
    th{color:#5c666b}
    code{background:#f0f2ee;border:1px solid #dde2da;border-radius:4px;padding:1px 4px}
    ul{margin:0;padding-left:20px}
  </style>
</head>
<body>
  <header>
    <nav><a href="/">Dashboard</a><a href="${escapeHtml(issueApiLink(issue.issue_identifier ?? ""))}">JSON</a></nav>
    <h1>${escapeHtml(issue.issue_identifier ?? "Unknown Issue")}</h1>
  </header>
  <main>
    <section><h2>Issue</h2>${renderIssueDefinitionList(issue)}</section>
    <section><h2>Run Attempts</h2>${renderRunAttempts(issue)}</section>
    <section><h2>Pull Request</h2>${renderPullRequestDetails(pullRequest, pullRequestStatus, tracked)}</section>
    <section><h2>Evidence</h2>${renderIssueEvidenceDetails(issue, evidence, tracked)}</section>
    <section><h2>Recent Events</h2><table><thead><tr><th>Time</th><th>Event</th><th>Session</th><th>Message</th></tr></thead><tbody>${eventRows}</tbody></table></section>
  </main>
</body>
</html>`;
}

type IssuePageSnapshot = {
  issue_identifier?: string;
  issue_id?: string;
  status?: string;
  workspace?: { path?: string | null } | null;
  attempts?: { restart_count?: number; current_retry_attempt?: number | null; run_attempts?: RunAttemptPageRecord[]; history?: RunAttemptPageRecord[] } | null;
  running?: { session_id?: string | null; turn_count?: number; last_event?: string | null; last_message?: string | null; last_event_at?: string | null } | null;
  retry?: { attempt?: number; due_at?: string; error?: string | null; context?: string | null } | null;
  recent_events?: Array<{ at?: string; event?: string; session_id?: string | null; message?: string | null }>;
  last_error?: string | null;
  tracked?: Record<string, unknown>;
};

type RunAttemptPageRecord = {
  attempt?: number | null;
  status?: string;
  started_at?: string;
  finished_at?: string | null;
  runtime_seconds?: number | null;
  workspace_path?: string | null;
  session_id?: string | null;
  turn_count?: number;
  error?: string | null;
  followup?: boolean;
};

function renderIssueDefinitionList(issue: IssuePageSnapshot): string {
  return `<dl>
    <dt>Status</dt><dd>${escapeHtml(issue.status ?? "")}</dd>
    <dt>Issue ID</dt><dd>${escapeHtml(issue.issue_id ?? "")}</dd>
    <dt>Workspace</dt><dd>${issue.workspace?.path ? `<code>${escapeHtml(issue.workspace.path)}</code>` : ""}</dd>
    <dt>Restarts</dt><dd>${issue.attempts?.restart_count ?? 0}</dd>
    <dt>Current Retry</dt><dd>${issue.attempts?.current_retry_attempt ?? ""}</dd>
    <dt>Running Session</dt><dd>${escapeHtml(issue.running?.session_id ?? "")}</dd>
    <dt>Turn Count</dt><dd>${issue.running?.turn_count ?? ""}</dd>
    <dt>Last Event</dt><dd>${escapeHtml(issue.running?.last_event ?? "")}</dd>
    <dt>Last Error</dt><dd>${escapeHtml(issue.last_error ?? "")}</dd>
  </dl>`;
}

function renderRunAttempts(issue: IssuePageSnapshot): string {
  const attempts = issue.attempts?.run_attempts ?? issue.attempts?.history ?? [];
  if (attempts.length === 0) return "<p>No worker run attempts have been recorded for this issue.</p>";
  const rows = attempts
    .slice(-50)
    .reverse()
    .map(
      (attempt) =>
        `<tr><td>${escapeHtml(attempt.started_at ?? "")}</td><td>${escapeHtml(attempt.finished_at ?? "")}</td><td>${escapeHtml(attempt.status ?? "")}</td><td>${attempt.attempt ?? ""}</td><td>${attempt.runtime_seconds ?? ""}</td><td>${attempt.turn_count ?? 0}</td><td>${attempt.followup ? "yes" : ""}</td><td>${escapeHtml(attempt.session_id ?? "")}</td><td>${escapeHtml(attempt.error ?? "")}</td></tr>`
    )
    .join("");
  return `<table><thead><tr><th>Started</th><th>Finished</th><th>Status</th><th>Attempt</th><th>Runtime</th><th>Turns</th><th>Follow-up</th><th>Session</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPullRequestDetails(pullRequest: Record<string, unknown> | null, status: Record<string, unknown> | null, tracked: Record<string, unknown>): string {
  if (!pullRequest) return "<p>No pull request is tracked for this issue.</p>";
  const url = readString(pullRequest.url);
  return `<dl>
    <dt>PR</dt><dd>${url ? `<a href="${escapeHtml(url)}">#${escapeHtml(readString(pullRequest.number) ?? "")}</a>` : escapeHtml(readString(pullRequest.number) ?? "")}</dd>
    <dt>Title</dt><dd>${escapeHtml(readString(pullRequest.title) ?? "")}</dd>
    <dt>Branch</dt><dd><code>${escapeHtml(readString(pullRequest.branch) ?? "")}</code></dd>
    <dt>Lifecycle</dt><dd>${escapeHtml(readString(status?.state) ?? readString(tracked.github_pr_terminal_state) ?? "")}</dd>
    <dt>Checks</dt><dd>${escapeHtml(readString(status?.checks_status) ?? "")}</dd>
    <dt>Review</dt><dd>${escapeHtml(readString(status?.review_status) ?? "")}</dd>
    <dt>Head SHA</dt><dd><code>${escapeHtml(readString(status?.head_sha) ?? "")}</code></dd>
    <dt>Summary</dt><dd>${escapeHtml(readString(status?.summary) ?? "")}</dd>
  </dl>`;
}

function renderIssueEvidenceDetails(issue: IssuePageSnapshot, evidence: Record<string, unknown> | null, tracked: Record<string, unknown>): string {
  const commentUrl = readString(tracked.github_evidence_comment_url);
  const lastError = readString(tracked.github_evidence_last_error);
  const warnings = readStringArray(tracked.github_evidence_warnings);
  if (!evidence && !commentUrl && !lastError && warnings.length === 0) return "<p>No worker evidence has been published for this issue.</p>";
  const verification = readStringArray(evidence?.verification);
  const commands = readEvidenceCommandArray(evidence?.commands);
  const appUrls = readStringArray(evidence?.app_urls);
  const artifacts = readObjectArray(evidence?.artifacts);
  return `<dl>
    <dt>Comment</dt><dd>${commentUrl ? `<a href="${escapeHtml(commentUrl)}">${escapeHtml(commentUrl)}</a>` : ""}</dd>
    <dt>Published At</dt><dd>${escapeHtml(readString(tracked.github_evidence_published_at) ?? "")}</dd>
    <dt>Summary</dt><dd>${escapeHtml(readString(evidence?.summary) ?? "")}</dd>
    <dt>Verification</dt><dd>${renderStringList(verification)}</dd>
    <dt>Commands</dt><dd>${renderEvidenceCommandList(commands)}</dd>
    <dt>App URLs</dt><dd>${renderLinkedList(appUrls)}</dd>
    <dt>Artifacts</dt><dd>${renderArtifactList(issue, artifacts)}</dd>
    <dt>Warnings</dt><dd>${renderWarningList(warnings)}</dd>
    <dt>Notes</dt><dd>${escapeHtml(readString(evidence?.notes) ?? "")}</dd>
    <dt>Error</dt><dd>${escapeHtml(lastError ?? "")}</dd>
  </dl>`;
}

function renderStringList(values: string[]): string {
  if (values.length === 0) return "";
  return `<ul>${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join("")}</ul>`;
}

function renderEvidenceCommandList(commands: NonNullable<EvidenceManifest["commands"]>): string {
  if (commands.length === 0) return "";
  return `<ul>${commands.map((command) => `<li>${renderEvidenceCommand(command)}</li>`).join("")}</ul>`;
}

function renderEvidenceCommand(command: NonNullable<EvidenceManifest["commands"]>[number]): string {
  const prefix = [command.kind, command.status].map((value) => value?.trim()).filter(Boolean).join(" ");
  const description = command.description?.trim();
  return `${prefix ? `${escapeHtml(prefix)}: ` : ""}<code>${escapeHtml(command.command)}</code>${description ? ` - ${escapeHtml(description)}` : ""}`;
}

function renderLinkedList(values: string[]): string {
  if (values.length === 0) return "";
  return `<ul>${values.map((value) => `<li><a href="${escapeHtml(value)}">${escapeHtml(value)}</a></li>`).join("")}</ul>`;
}

function renderArtifactList(issue: IssuePageSnapshot, artifacts: Record<string, unknown>[]): string {
  if (artifacts.length === 0) return "";
  return `<ul>${artifacts
    .map((artifact) => {
      const artifactPath = readString(artifact.path);
      const url = readString(artifact.url);
      const localLink = artifactPath ? localArtifactLink(issue, artifactPath) : null;
      const target = url
        ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
        : artifactPath
          ? `${localLink ? `<a href="${escapeHtml(localLink)}"><code>${escapeHtml(artifactPath)}</code></a>` : `<code>${escapeHtml(artifactPath)}</code>`}`
          : "";
      const label = readString(artifact.label) ?? readString(artifact.kind) ?? "artifact";
      const description = readString(artifact.description);
      return `<li>${escapeHtml(label)} ${target}${description ? ` - ${escapeHtml(description)}` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function localArtifactLink(issue: IssuePageSnapshot, artifactPath: string): string | null {
  const identifier = issue.issue_identifier;
  const workspacePath = issue.workspace?.path ?? undefined;
  if (!identifier) return null;
  const normalized = normalizeEvidenceArtifactPath(artifactPath, workspacePath);
  if (!normalized || !isDurableEvidenceArtifactPath(normalized)) return null;
  return `/artifacts/${encodeURIComponent(identifier)}/${encodePathSegments(normalized)}`;
}

function renderWarningList(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readObjectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(readObject).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

async function artifactListSnapshot(snapshot: unknown): Promise<unknown> {
  const issue = snapshot as IssuePageSnapshot;
  const evidence = readEvidenceManifestFromIssue(issue);
  const workspacePath = issue.workspace?.path ?? null;
  const artifactScan = evidence && workspacePath ? await localEvidenceArtifactScan(evidence, workspacePath) : { files: [], warnings: [] };
  const localFiles = artifactScan.files.map((file) => ({
    path: file.repositoryPath,
    url: `/artifacts/${encodeURIComponent(issue.issue_identifier ?? "")}/${encodePathSegments(file.repositoryPath)}`
  }));
  return {
    issue_identifier: issue.issue_identifier ?? null,
    workspace_path: workspacePath,
    artifacts: (evidence?.artifacts ?? []).map((artifact) => {
      const normalizedPath = normalizeEvidenceArtifactPath(artifact.path, workspacePath ?? undefined);
      const matchingFiles = normalizedPath ? localFiles.filter((file) => file.path === normalizedPath || file.path.startsWith(`${normalizedPath}/`)) : [];
      return {
        kind: artifact.kind ?? null,
        label: artifact.label ?? null,
        description: artifact.description ?? null,
        path: artifact.path ?? null,
        normalized_path: normalizedPath,
        url: artifact.url ?? null,
        local_url: matchingFiles.find((file) => file.path === normalizedPath)?.url ?? null,
        local_files: matchingFiles
      };
    }),
    warnings: artifactScan.warnings,
    files: localFiles
  };
}

async function serveEvidenceArtifact(response: ServerResponse, snapshot: unknown, requestedPath: string): Promise<void> {
  const issue = snapshot as IssuePageSnapshot;
  const workspacePath = issue.workspace?.path;
  const evidence = readEvidenceManifestFromIssue(issue);
  const normalizedPath = normalizeEvidenceArtifactPath(requestedPath, workspacePath ?? undefined);
  if (!workspacePath || !evidence || !normalizedPath || !isDurableEvidenceArtifactPath(normalizedPath)) {
    return writeJson(response, 404, { error: { code: "artifact_not_found", message: "Evidence artifact was not found" } });
  }
  const files = await localEvidenceArtifactFiles(evidence, workspacePath);
  const file = files.find((entry) => entry.repositoryPath === normalizedPath);
  if (!file) return writeJson(response, 404, { error: { code: "artifact_not_found", message: "Evidence artifact was not found" } });
  let info;
  try {
    info = await stat(file.sourcePath);
  } catch {
    return writeJson(response, 404, { error: { code: "artifact_not_found", message: "Evidence artifact was not found" } });
  }
  if (!info.isFile()) return writeJson(response, 404, { error: { code: "artifact_not_found", message: "Evidence artifact was not found" } });
  response.writeHead(200, {
    "content-type": contentTypeForPath(file.repositoryPath),
    "content-length": String(info.size),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; media-src 'self' data: blob:",
    "content-disposition": `inline; filename="${escapeHeaderQuotedString(path.basename(file.repositoryPath))}"`
  });
  await new Promise<void>((resolve) => {
    const stream = createReadStream(file.sourcePath);
    stream.on("error", () => {
      response.destroy();
      resolve();
    });
    response.on("finish", resolve);
    response.on("close", resolve);
    stream.pipe(response);
  });
}

function readEvidenceManifestFromIssue(issue: IssuePageSnapshot): EvidenceManifest | null {
  const evidence = readObject(issue.tracked?.github_evidence_manifest);
  if (!evidence) return null;
  return {
    ...(typeof evidence.summary === "string" ? { summary: evidence.summary } : {}),
    ...(Array.isArray(evidence.verification) ? { verification: evidence.verification.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(Array.isArray(evidence.commands) ? { commands: readEvidenceCommandArray(evidence.commands) } : {}),
    ...(Array.isArray(evidence.app_urls) ? { app_urls: evidence.app_urls.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(Array.isArray(evidence.artifacts) ? { artifacts: evidence.artifacts.map(readEvidenceArtifact).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) } : {}),
    ...(typeof evidence.notes === "string" ? { notes: evidence.notes } : {})
  };
}

function readEvidenceCommandArray(value: unknown): NonNullable<EvidenceManifest["commands"]> {
  return Array.isArray(value) ? value.map(readEvidenceCommand).filter((entry): entry is NonNullable<EvidenceManifest["commands"]>[number] => Boolean(entry)) : [];
}

function readEvidenceCommand(value: unknown): NonNullable<EvidenceManifest["commands"]>[number] | null {
  const command = readObject(value);
  if (!command || typeof command.command !== "string" || command.command.trim().length === 0) return null;
  return {
    command: command.command,
    ...(typeof command.kind === "string" ? { kind: command.kind } : {}),
    ...(typeof command.status === "string" ? { status: command.status } : {}),
    ...(typeof command.description === "string" ? { description: command.description } : {})
  };
}

function readEvidenceArtifact(value: unknown): NonNullable<EvidenceManifest["artifacts"]>[number] | null {
  const artifact = readObject(value);
  if (!artifact) return null;
  return {
    ...(typeof artifact.path === "string" ? { path: artifact.path } : {}),
    ...(typeof artifact.url === "string" ? { url: artifact.url } : {}),
    ...(typeof artifact.kind === "string" ? { kind: artifact.kind } : {}),
    ...(typeof artifact.label === "string" ? { label: artifact.label } : {}),
    ...(typeof artifact.description === "string" ? { description: artifact.description } : {})
  };
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".log":
    case ".md":
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function encodePathSegments(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeHeaderQuotedString(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function renderEvidenceCell(evidence: {
  comment_url?: string | null;
  last_error?: string | null;
  warnings?: string[];
  manifest?: { artifacts?: unknown[]; app_urls?: string[]; verification?: string[]; commands?: unknown[] } | null;
} | null): string {
  if (!evidence) return "";
  if (evidence.last_error) return `<span title="${escapeHtml(evidence.last_error)}">error</span>`;
  const artifactCount = evidence.manifest?.artifacts?.length ?? 0;
  const appCount = evidence.manifest?.app_urls?.length ?? 0;
  const verificationCount = evidence.manifest?.verification?.length ?? 0;
  const commandCount = evidence.manifest?.commands?.length ?? 0;
  const warningCount = evidence.warnings?.length ?? 0;
  const detail = [
    artifactCount ? `${artifactCount} artifact${artifactCount === 1 ? "" : "s"}` : "",
    appCount ? `${appCount} app URL${appCount === 1 ? "" : "s"}` : "",
    verificationCount ? `${verificationCount} check${verificationCount === 1 ? "" : "s"}` : "",
    commandCount ? `${commandCount} command${commandCount === 1 ? "" : "s"}` : "",
    warningCount ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""
  ]
    .filter(Boolean)
    .join(", ");
  const label = detail ? `evidence (${detail})` : "evidence";
  return evidence.comment_url ? `<a href="${escapeHtml(evidence.comment_url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

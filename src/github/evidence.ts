import path from "node:path";
import type { EvidenceArtifact, EvidenceManifest, PullRequestEvidencePublication, PullRequestEvidencePublisher, PublishedPullRequest, SymphonyConfig } from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { GitHubApiClient, type FetchLike } from "./client.js";

export const SYMPHONY_EVIDENCE_COMMENT_MARKER = "<!-- symphony:evidence -->";

export class GitHubPullRequestEvidencePublisher implements PullRequestEvidencePublisher {
  private readonly api: GitHubApiClient;

  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly logger: Logger,
    fetchImpl: FetchLike = fetch
  ) {
    this.api = new GitHubApiClient(getConfig, fetchImpl);
  }

  async publish(input: {
    pullRequest: PublishedPullRequest;
    workspacePath: string;
    manifest: EvidenceManifest;
    previousCommentId?: number | null;
  }): Promise<PullRequestEvidencePublication> {
    const config = this.getConfig().github;
    if (!config.enabled) throw new SymphonyError("github_disabled", "GitHub evidence publishing is disabled");
    if (!config.owner || !config.repo || !config.token) throw new SymphonyError("github_not_configured", "GitHub evidence publishing is not fully configured");

    const body = renderEvidenceComment(input.pullRequest, input.manifest, input.workspacePath, { owner: config.owner, repo: config.repo });
    const existingCommentId = input.previousCommentId ?? (await this.findExistingEvidenceComment(input.pullRequest.number));
    const payload = existingCommentId
      ? await this.updateExistingComment(input.pullRequest.number, existingCommentId, body)
      : await this.createComment(input.pullRequest.number, body);
    const commentId = readCommentId(payload);
    const url = readString(payload.html_url);
    this.logger.info("github pr evidence published", { pr_number: input.pullRequest.number, pr_url: input.pullRequest.url, comment_id: commentId, comment_url: url });
    return { comment_id: commentId, url };
  }

  private async findExistingEvidenceComment(number: number): Promise<number | null> {
    const config = this.getConfig().github;
    if (!config.owner || !config.repo) return null;
    const comments = await this.api.request<unknown[]>("GET", `/repos/${config.owner}/${config.repo}/issues/${number}/comments?per_page=100`);
    for (const comment of Array.isArray(comments) ? comments : []) {
      if (!comment || typeof comment !== "object") continue;
      const record = comment as Record<string, unknown>;
      const body = readString(record.body);
      const id = typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null;
      if (body?.includes(SYMPHONY_EVIDENCE_COMMENT_MARKER) && id) return id;
    }
    return null;
  }

  private async updateExistingComment(number: number, commentId: number, body: string): Promise<Record<string, unknown>> {
    const config = this.getConfig().github;
    try {
      return await this.api.request<Record<string, unknown>>("PATCH", `/repos/${config.owner}/${config.repo}/issues/comments/${commentId}`, { body });
    } catch (error) {
      if (!isGitHubNotFound(error)) throw error;
      this.logger.warn("github pr evidence comment id was stale", { pr_number: number, comment_id: commentId });
      const discoveredCommentId = await this.findExistingEvidenceComment(number);
      if (discoveredCommentId && discoveredCommentId !== commentId) {
        return await this.api.request<Record<string, unknown>>("PATCH", `/repos/${config.owner}/${config.repo}/issues/comments/${discoveredCommentId}`, { body });
      }
      return this.createComment(number, body);
    }
  }

  private async createComment(number: number, body: string): Promise<Record<string, unknown>> {
    const config = this.getConfig().github;
    return await this.api.request<Record<string, unknown>>("POST", `/repos/${config.owner}/${config.repo}/issues/${number}/comments`, { body });
  }
}

export function renderEvidenceComment(
  pullRequest: PublishedPullRequest,
  manifest: EvidenceManifest,
  workspacePath?: string,
  repository?: { owner: string | null; repo: string | null }
): string {
  const lines = [
    SYMPHONY_EVIDENCE_COMMENT_MARKER,
    "## Symphony Worker Evidence",
    "",
    manifest.summary?.trim() || "Worker evidence was provided for this PR update.",
    "",
    `Pull request: ${pullRequest.url}`
  ];

  if (manifest.verification?.length) {
    lines.push("", "### Verification");
    for (const entry of manifest.verification.slice(0, 20)) lines.push(`- ${singleLine(entry)}`);
  }

  if (manifest.app_urls?.length) {
    lines.push("", "### App URLs");
    for (const entry of manifest.app_urls.slice(0, 20)) lines.push(`- ${singleLine(entry)}`);
  }

  const artifacts = manifest.artifacts?.filter((artifact) => hasArtifactTarget(artifact, workspacePath)) ?? [];
  if (artifacts.length > 0) {
    lines.push("", "### Artifacts");
    for (const artifact of artifacts.slice(0, 50)) lines.push(`- ${renderArtifact(pullRequest, artifact, workspacePath, repository)}`);
  }

  if (manifest.notes?.trim()) lines.push("", "### Notes", manifest.notes.trim());
  return lines.join("\n");
}

function renderArtifact(pullRequest: PublishedPullRequest, artifact: EvidenceArtifact, workspacePath?: string, repository?: { owner: string | null; repo: string | null }): string {
  const label = artifact.label?.trim() || artifact.kind?.trim() || "artifact";
  const normalizedPath = normalizeArtifactPath(artifact.path, workspacePath);
  const target = artifact.url?.trim() || normalizedPath || "";
  const description = artifact.description?.trim();
  const renderedTarget = artifact.url?.trim() ? target : renderArtifactPathTarget(pullRequest, target, repository);
  return `${label}: ${renderedTarget}${description ? ` - ${singleLine(description)}` : ""}`;
}

function renderArtifactPathTarget(pullRequest: PublishedPullRequest, normalizedPath: string, repository?: { owner: string | null; repo: string | null }): string {
  const url = artifactBlobUrl(pullRequest, normalizedPath, repository);
  return url ? `[${escapeMarkdownText(normalizedPath)}](${url})` : `\`${normalizedPath}\``;
}

function artifactBlobUrl(pullRequest: PublishedPullRequest, normalizedPath: string, repository?: { owner: string | null; repo: string | null }): string | null {
  const repoUrl = repository?.owner && repository.repo ? repositoryWebUrlFromPullRequest(pullRequest, repository.owner, repository.repo) : null;
  if (!repoUrl) return null;
  const branch = encodeURI(pullRequest.branch.trim());
  const artifactPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${repoUrl}/blob/${branch}/${artifactPath}`;
}

function repositoryWebUrlFromPullRequest(pullRequest: PublishedPullRequest, owner: string, repo: string): string | null {
  const escapedOwner = escapeRegExp(owner);
  const escapedRepo = escapeRegExp(repo);
  const match = pullRequest.url.match(new RegExp(`^(https?://[^/]+/${escapedOwner}/${escapedRepo})/pull/\\d+(?:$|[/?#])`));
  return match?.[1] ?? null;
}

function hasArtifactTarget(artifact: EvidenceArtifact, workspacePath?: string): boolean {
  return Boolean(artifact.url?.trim() || normalizeArtifactPath(artifact.path, workspacePath));
}

function normalizeArtifactPath(value: string | undefined, workspacePath?: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
  let candidate = raw;
  if (path.isAbsolute(raw)) {
    if (workspacePath && isPathInside(workspacePath, raw)) {
      candidate = path.relative(workspacePath, raw);
    } else if (raw === "/workspace" || raw.startsWith("/workspace/")) {
      candidate = raw.slice("/workspace/".length);
    } else {
      return null;
    }
  }
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isGitHubNotFound(error: unknown): boolean {
  if (!(error instanceof SymphonyError) || error.code !== "github_api_error") return false;
  const cause = error.causeValue;
  return Boolean(cause && typeof cause === "object" && (cause as { status?: unknown }).status === 404);
}

function readCommentId(payload: unknown): number {
  if (!payload || typeof payload !== "object") throw new SymphonyError("github_api_error", "GitHub comment response was not an object");
  const id = (payload as Record<string, unknown>).id;
  if (typeof id !== "number" || !Number.isFinite(id)) throw new SymphonyError("github_api_error", "GitHub comment response did not include id");
  return id;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceArtifact, EvidenceManifest, PullRequestEvidencePublication, PullRequestEvidencePublisher, PublishedPullRequest, SymphonyConfig } from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { GitHubApiClient, type FetchLike } from "./client.js";
import { localEvidenceArtifactScan, normalizeEvidenceArtifactPath } from "./evidenceArtifacts.js";

export const TAKT_EVIDENCE_COMMENT_MARKER = "<!-- takt:evidence -->";
const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_UPLOAD_BYTES = 10 * 1024 * 1024;

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

    const artifactPublication = await this.publishLocalArtifacts(input.pullRequest, input.workspacePath, input.manifest);
    const artifactWarnings = [
      ...artifactPublication.warnings,
      ...(await evidenceArtifactWarnings(input.workspacePath, input.manifest, artifactPublication.uploadedPaths))
    ];
    const body = renderEvidenceComment(input.pullRequest, input.manifest, input.workspacePath, { owner: config.owner, repo: config.repo }, artifactWarnings);
    const existingCommentId = input.previousCommentId ?? (await this.findExistingEvidenceComment(input.pullRequest.number));
    const payload = existingCommentId
      ? await this.updateExistingComment(input.pullRequest.number, existingCommentId, body)
      : await this.createComment(input.pullRequest.number, body);
    const commentId = readCommentId(payload);
    const url = readString(payload.html_url);
    this.logger.info("github pr evidence published", {
      pr_number: input.pullRequest.number,
      pr_url: input.pullRequest.url,
      comment_id: commentId,
      comment_url: url,
      warning_count: artifactWarnings.length
    });
    return { comment_id: commentId, url, warnings: artifactWarnings };
  }

  private async publishLocalArtifacts(
    pullRequest: PublishedPullRequest,
    workspacePath: string,
    manifest: EvidenceManifest
  ): Promise<{ uploadedPaths: Set<string>; warnings: string[] }> {
    const config = this.getConfig().github;
    const uploadedPaths = new Set<string>();
    const warnings: string[] = [];
    const artifactScan = await localEvidenceArtifactScan(manifest, workspacePath);
    warnings.push(...artifactScan.warnings);
    for (const artifactFile of artifactScan.files) {
      try {
        const info = await stat(artifactFile.sourcePath);
        if (info.size > MAX_EVIDENCE_UPLOAD_BYTES) {
          warnings.push(`Artifact path was not uploaded because it is larger than ${MAX_EVIDENCE_UPLOAD_BYTES} bytes: ${artifactFile.repositoryPath}`);
          continue;
        }
        const content = await readFile(artifactFile.sourcePath);
        const sha = await this.findExistingContentSha(artifactFile.repositoryPath, pullRequest.branch);
        await this.api.request("PUT", `/repos/${config.owner}/${config.repo}/contents/${contentRoutePath(artifactFile.repositoryPath)}`, {
          message: `Add Takt evidence artifact ${artifactFile.repositoryPath}`,
          content: content.toString("base64"),
          branch: pullRequest.branch,
          ...(sha ? { sha } : {})
        });
        uploadedPaths.add(artifactFile.repositoryPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Artifact path could not be uploaded to the PR branch: ${artifactFile.repositoryPath} (${singleLine(message)})`);
        this.logger.warn("github pr evidence artifact upload failed", { pr_number: pullRequest.number, artifact_path: artifactFile.repositoryPath, error: message });
      }
    }
    return { uploadedPaths, warnings };
  }

  private async findExistingContentSha(repositoryPath: string, branch: string): Promise<string | null> {
    const config = this.getConfig().github;
    try {
      const payload = await this.api.request<Record<string, unknown>>(
        "GET",
        `/repos/${config.owner}/${config.repo}/contents/${contentRoutePath(repositoryPath)}?ref=${encodeURIComponent(branch)}`
      );
      return typeof payload.sha === "string" ? payload.sha : null;
    } catch (error) {
      if (isGitHubNotFound(error)) return null;
      throw error;
    }
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
      if (body?.includes(TAKT_EVIDENCE_COMMENT_MARKER) && id) return id;
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
  repository?: { owner: string | null; repo: string | null },
  artifactWarnings: string[] = []
): string {
  const lines = [
    TAKT_EVIDENCE_COMMENT_MARKER,
    "## Takt Worker Evidence",
    "",
    manifest.summary?.trim() || "Worker evidence was provided for this PR update.",
    "",
    `Pull request: ${pullRequest.url}`
  ];

  if (manifest.verification?.length) {
    lines.push("", "### Verification");
    for (const entry of manifest.verification.slice(0, 20)) lines.push(`- ${singleLine(entry)}`);
  }

  if (manifest.commands?.length) {
    lines.push("", "### Evidence Commands");
    for (const command of manifest.commands.slice(0, 20)) lines.push(`- ${renderEvidenceCommand(command)}`);
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

  if (artifactWarnings.length > 0) {
    lines.push("", "### Artifact Warnings");
    for (const warning of artifactWarnings.slice(0, 50)) lines.push(`- ${singleLine(warning)}`);
  }

  if (manifest.notes?.trim()) lines.push("", "### Notes", manifest.notes.trim());
  return lines.join("\n");
}

async function evidenceArtifactWarnings(workspacePath: string, manifest: EvidenceManifest, uploadedPaths: Set<string> = new Set()): Promise<string[]> {
  const warnings: string[] = [];
  for (const artifact of manifest.artifacts ?? []) {
    if (artifact.url?.trim()) continue;
    const rawPath = artifact.path?.trim();
    if (!rawPath) continue;
    const normalizedPath = normalizeEvidenceArtifactPath(rawPath, workspacePath);
    if (!normalizedPath) {
      warnings.push(`Artifact path cannot be linked because it is outside the workspace or invalid: ${rawPath}`);
      continue;
    }
    try {
      const info = await stat(path.join(workspacePath, normalizedPath));
      if (!info.isFile() && !info.isDirectory()) warnings.push(`Artifact path is not a regular file or directory: ${normalizedPath}`);
    } catch {
      warnings.push(`Artifact path was not found in the worker workspace at publish time: ${normalizedPath}`);
      continue;
    }
    if (!uploadedPaths.has(normalizedPath) && !(await isGitTracked(workspacePath, normalizedPath))) {
      warnings.push(`Artifact path is not tracked by git at publish time, so the PR branch link may be unavailable: ${normalizedPath}`);
    }
  }
  return warnings;
}

async function isGitTracked(workspacePath: string, normalizedPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", normalizedPath], { cwd: workspacePath });
    return true;
  } catch {
    return false;
  }
}

function renderArtifact(pullRequest: PublishedPullRequest, artifact: EvidenceArtifact, workspacePath?: string, repository?: { owner: string | null; repo: string | null }): string {
  const label = artifact.label?.trim() || artifact.kind?.trim() || "artifact";
  const normalizedPath = normalizeEvidenceArtifactPath(artifact.path, workspacePath);
  const target = artifact.url?.trim() || normalizedPath || "";
  const description = artifact.description?.trim();
  const renderedTarget = artifact.url?.trim() ? target : renderArtifactPathTarget(pullRequest, target, repository);
  const previewUrl = imagePreviewUrl(pullRequest, artifact, normalizedPath, repository);
  const preview = previewUrl ? `\n  ![${escapeMarkdownText(singleLine(`${label}: ${target}`))}](${previewUrl})` : "";
  return `${label}: ${renderedTarget}${description ? ` - ${singleLine(description)}` : ""}${preview}`;
}

function renderArtifactPathTarget(pullRequest: PublishedPullRequest, normalizedPath: string, repository?: { owner: string | null; repo: string | null }): string {
  const url = artifactBlobUrl(pullRequest, normalizedPath, repository);
  return url ? `[${escapeMarkdownText(normalizedPath)}](${url})` : `\`${normalizedPath}\``;
}

function renderEvidenceCommand(command: NonNullable<EvidenceManifest["commands"]>[number]): string {
  const prefix = [command.kind?.trim(), command.status?.trim()]
    .filter((value): value is string => Boolean(value))
    .map(singleLine)
    .join(" ");
  const description = command.description?.trim();
  return `${prefix ? `${prefix}: ` : ""}${singleLine(command.command)}${description ? ` - ${singleLine(description)}` : ""}`;
}

function artifactBlobUrl(pullRequest: PublishedPullRequest, normalizedPath: string, repository?: { owner: string | null; repo: string | null }): string | null {
  const repoUrl = repository?.owner && repository.repo ? repositoryWebUrlFromPullRequest(pullRequest, repository.owner, repository.repo) : null;
  if (!repoUrl) return null;
  return `${repoUrl}/blob/${branchPath(pullRequest.branch)}/${contentRoutePath(normalizedPath)}`;
}

function imagePreviewUrl(
  pullRequest: PublishedPullRequest,
  artifact: EvidenceArtifact,
  normalizedPath: string | null,
  repository?: { owner: string | null; repo: string | null }
): string | null {
  const externalUrl = artifact.url?.trim();
  if (externalUrl) return isImageArtifact(artifact, externalUrl) ? externalUrl : null;
  if (!normalizedPath || !isImageArtifact(artifact, normalizedPath)) return null;
  const repoUrl = repository?.owner && repository.repo ? repositoryWebUrlFromPullRequest(pullRequest, repository.owner, repository.repo) : null;
  if (!repoUrl) return null;
  return `${repoUrl}/raw/${branchPath(pullRequest.branch)}/${contentRoutePath(normalizedPath)}`;
}

function isImageArtifact(artifact: EvidenceArtifact, target: string): boolean {
  const kind = artifact.kind?.trim().toLowerCase();
  if (kind && ["screenshot", "image", "photo"].includes(kind)) return true;
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(path.posix.extname(targetPathname(target)).toLowerCase());
}

function targetPathname(target: string): string {
  try {
    return new URL(target).pathname;
  } catch {
    return target;
  }
}

function branchPath(branch: string): string {
  return branch
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function repositoryWebUrlFromPullRequest(pullRequest: PublishedPullRequest, owner: string, repo: string): string | null {
  const escapedOwner = escapeRegExp(owner);
  const escapedRepo = escapeRegExp(repo);
  const match = pullRequest.url.match(new RegExp(`^(https?://[^/]+/${escapedOwner}/${escapedRepo})/pull/\\d+(?:$|[/?#])`));
  return match?.[1] ?? null;
}

function hasArtifactTarget(artifact: EvidenceArtifact, workspacePath?: string): boolean {
  return Boolean(artifact.url?.trim() || normalizeEvidenceArtifactPath(artifact.path, workspacePath));
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

function contentRoutePath(repositoryPath: string): string {
  return repositoryPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

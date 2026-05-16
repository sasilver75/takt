import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Issue, PrReadyManifest, PublishedPullRequest, PullRequestPublisher, SymphonyConfig } from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { GitHubApiClient, type FetchLike } from "./client.js";

const execFileAsync = promisify(execFile);

export class GitHubPullRequestPublisher implements PullRequestPublisher {
  private readonly api: GitHubApiClient;

  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly logger: Logger,
    fetchImpl: FetchLike = fetch
  ) {
    this.api = new GitHubApiClient(getConfig, fetchImpl);
  }

  async publish(input: { issue: Issue; workspacePath: string; manifest: PrReadyManifest }): Promise<PublishedPullRequest> {
    const config = this.getConfig().github;
    if (!config.enabled) throw new SymphonyError("github_disabled", "GitHub publishing is disabled");
    if (!config.owner || !config.repo || !config.token) throw new SymphonyError("github_not_configured", "GitHub publishing is not fully configured");

    const branch = branchName(config.branch_prefix, input.issue);
    await ensureCleanWorkspace(input.workspacePath, config.pr_ready_file);
    await git(input.workspacePath, ["fetch", config.remote, config.base_branch]);
    const baseRef = `FETCH_HEAD`;
    const ahead = Number(await gitOut(input.workspacePath, ["rev-list", "--count", `${baseRef}..HEAD`]));
    if (!Number.isFinite(ahead) || ahead <= 0) {
      throw new SymphonyError("github_no_commits", `Workspace has no commits ahead of ${config.remote}/${config.base_branch}`);
    }
    const title = input.manifest.title?.trim() || `${input.issue.identifier}: ${input.issue.title}`;
    const body = renderPullRequestBody(input.issue, input.manifest);
    const existing = await this.findOpenPullRequest(branch);
    await git(input.workspacePath, ["checkout", "-B", branch]);
    await this.pushBranch(input.workspacePath, branch, existing?.head_sha ?? null);

    const published = existing
      ? await this.updatePullRequest(existing.number, { title, body })
      : await this.createPullRequest({ title, body, branch });
    this.logger.info("github pr published", {
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      pr_number: published.number,
      pr_url: published.url,
      branch
    });
    return { number: published.number, url: published.url, branch, title, created: !existing };
  }

  private async pushBranch(workspacePath: string, branch: string, expectedRemoteSha: string | null): Promise<void> {
    const config = this.getConfig().github;
    const askpass = config.token ? await createAskpass(config.token) : null;
    try {
      await git(
        workspacePath,
        [
          "push",
          ...(expectedRemoteSha ? [`--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`] : []),
          config.remote,
          `HEAD:refs/heads/${branch}`
        ],
        askpass ? { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" } : {}
      );
    } finally {
      if (askpass) await rm(path.dirname(askpass), { recursive: true, force: true });
    }
  }

  private async findOpenPullRequest(branch: string): Promise<{ number: number; url: string; head_sha: string | null } | null> {
    const config = this.getConfig().github;
    const head = `${config.owner}:${branch}`;
    const response = await this.api.request("GET", `/repos/${config.owner}/${config.repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(config.base_branch)}`);
    if (!Array.isArray(response)) return null;
    const first = response[0] as Record<string, unknown> | undefined;
    if (!first) return null;
    return readPublished(first);
  }

  private async createPullRequest(input: { title: string; body: string; branch: string }): Promise<{ number: number; url: string; head_sha: string | null }> {
    const config = this.getConfig().github;
    return readPublished(
      await this.api.request("POST", `/repos/${config.owner}/${config.repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.branch,
        base: config.base_branch,
        draft: config.draft
      })
    );
  }

  private async updatePullRequest(number: number, input: { title: string; body: string }): Promise<{ number: number; url: string; head_sha: string | null }> {
    const config = this.getConfig().github;
    return readPublished(await this.api.request("PATCH", `/repos/${config.owner}/${config.repo}/pulls/${number}`, input));
  }
}

export function renderPullRequestBody(issue: Issue, manifest: PrReadyManifest): string {
  const verification = Array.isArray(manifest.verification) && manifest.verification.length > 0
    ? manifest.verification.map((entry) => `- ${entry}`).join("\n")
    : "- Not provided";
  return [
    `Linear: ${issue.url ?? issue.identifier}`,
    "",
    "## Summary",
    manifest.body?.trim() || manifest.summary?.trim() || "No summary provided.",
    "",
    "## Verification",
    verification,
    "",
    "## Risk",
    manifest.risk?.trim() || "Not provided."
  ].join("\n");
}

export function branchName(prefix: string, issue: Issue): string {
  const slug = `${issue.identifier}-${issue.title}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${prefix.replace(/\/+$/g, "")}/${slug || issue.identifier.toLowerCase()}`;
}

async function ensureCleanWorkspace(workspacePath: string, prReadyFile: string): Promise<void> {
  const status = await gitOut(workspacePath, ["status", "--porcelain"]);
  const dirty = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.slice(3) !== prReadyFile);
  if (dirty.length > 0) throw new SymphonyError("github_dirty_workspace", "Workspace has uncommitted changes; worker must commit before PR publishing");
}

async function createAskpass(token: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-git-askpass-"));
  const script = path.join(dir, "askpass.sh");
  await writeFile(
    script,
    `#!/bin/sh\ncase "$1" in\n*Username*) printf '%s\\n' x-access-token ;;\n*) printf '%s\\n' '${shellSingleQuote(token)}' ;;\nesac\n`,
    { mode: 0o700 }
  );
  return script;
}

function readPublished(payload: unknown): { number: number; url: string; head_sha: string | null } {
  if (!payload || typeof payload !== "object") throw new SymphonyError("github_api_error", "GitHub PR response was not an object");
  const record = payload as Record<string, unknown>;
  const number = typeof record.number === "number" ? record.number : null;
  const url = typeof record.html_url === "string" ? record.html_url : null;
  const head = record.head && typeof record.head === "object" ? (record.head as Record<string, unknown>) : null;
  const headSha = typeof head?.sha === "string" ? head.sha : null;
  if (!number || !url) throw new SymphonyError("github_api_error", "GitHub PR response did not include number/html_url");
  return { number, url, head_sha: headSha };
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  await execFileAsync("git", args, { cwd, env: { ...process.env, ...env } });
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

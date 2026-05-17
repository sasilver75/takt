import type { PullRequestMergeResult, PullRequestMerger, SymphonyConfig } from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { GitHubApiClient, type FetchLike } from "./client.js";

export class GitHubPullRequestMerger implements PullRequestMerger {
  private readonly api: GitHubApiClient;

  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly logger: Logger,
    fetchImpl: FetchLike = fetch
  ) {
    this.api = new GitHubApiClient(getConfig, fetchImpl);
  }

  async merge(input: Parameters<PullRequestMerger["merge"]>[0]): Promise<PullRequestMergeResult> {
    const config = this.getConfig().github;
    if (!config.merge.enabled) throw new SymphonyError("github_merge_disabled", "GitHub PR merging is disabled");
    if (!config.owner || !config.repo || !config.token) throw new SymphonyError("github_not_configured", "GitHub merge integration is not fully configured");
    if (!input.inspection.head_sha) throw new SymphonyError("github_merge_missing_head", "Cannot merge a PR without a known head SHA");

    const payload = await this.api.request<Record<string, unknown>>("PUT", `/repos/${config.owner}/${config.repo}/pulls/${input.pullRequest.number}/merge`, {
      sha: input.inspection.head_sha,
      merge_method: config.merge.method,
      commit_title: `${input.pullRequest.title} (#${input.pullRequest.number})`,
      commit_message: `Merged by Takt.\n\n${input.pullRequest.url}`
    });
    const result = readMergeResult(input.pullRequest.number, input.pullRequest.url, payload);
    if (!result.merged) return result;

    if (config.merge.delete_branch) await this.deleteBranch(input.pullRequest.branch);
    this.logger.info("github pr merged", {
      pr_number: input.pullRequest.number,
      pr_url: input.pullRequest.url,
      branch: input.pullRequest.branch,
      sha: result.sha
    });
    return result;
  }

  private async deleteBranch(branch: string): Promise<void> {
    const config = this.getConfig().github;
    if (!config.owner || !config.repo) return;
    try {
      await this.api.request("DELETE", `/repos/${config.owner}/${config.repo}/git/refs/heads/${encodeBranchRef(branch)}`);
      this.logger.info("github pr branch deleted", { branch });
    } catch (error) {
      this.logger.warn("github pr branch delete failed", { branch, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readMergeResult(number: number, url: string, payload: unknown): PullRequestMergeResult {
  if (!payload || typeof payload !== "object") throw new SymphonyError("github_api_error", "GitHub merge response was not an object");
  const record = payload as Record<string, unknown>;
  return {
    number,
    url,
    merged: record.merged === true,
    sha: typeof record.sha === "string" ? record.sha : null,
    message: typeof record.message === "string" ? record.message : null
  };
}

function encodeBranchRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

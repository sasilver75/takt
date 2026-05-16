import type {
  DiscoveredPullRequest,
  PublishedPullRequest,
  PullRequestCheckSummary,
  PullRequestChecksStatus,
  PullRequestInspection,
  PullRequestIssueCommentSummary,
  PullRequestReviewCommentSummary,
  PullRequestReviewSummary,
  PullRequestReviewStatus,
  PullRequestReviewThreadSummary,
  PullRequestTracker,
  PullRequestDiscoveryOptions,
  PullRequestDiscoveryState,
  SymphonyConfig
} from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { GitHubApiClient, type FetchLike } from "./client.js";
import { SYMPHONY_EVIDENCE_COMMENT_MARKER } from "./evidence.js";

export class GitHubPullRequestTracker implements PullRequestTracker {
  private readonly api: GitHubApiClient;

  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly logger: Logger,
    fetchImpl: FetchLike = fetch
  ) {
    this.api = new GitHubApiClient(getConfig, fetchImpl);
  }

  async inspect(input: PublishedPullRequest): Promise<PullRequestInspection> {
    const config = this.getConfig().github;
    if (!config.owner || !config.repo) throw new SymphonyError("github_not_configured", "GitHub owner/repo are required for PR inspection");
    const pr = await this.api.request<Record<string, unknown>>("GET", `/repos/${config.owner}/${config.repo}/pulls/${input.number}`);
    const number = readNumber(pr.number, input.number);
    const url = readString(pr.html_url) ?? input.url;
    const branch = readNestedString(pr, ["head", "ref"]) ?? input.branch;
    const headSha = readNestedString(pr, ["head", "sha"]);
    const state = readLifecycleState(pr);
    const checks = headSha ? await this.inspectChecks(headSha) : [];
    const reviews = state === "open" ? await this.inspectReviews(input.number) : [];
    const reviewComments = state === "open" ? await this.inspectReviewComments(input.number) : [];
    const issueComments = state === "open" ? await this.inspectIssueComments(input.number) : [];
    const reviewThreads = state === "open" ? await this.inspectReviewThreads(input.number) : [];
    const checksStatus = classifyCheckRuns(checks);
    const reviewStatus = state === "open" ? classifyReviews(reviews) : "unknown";
    const inspection: PullRequestInspection = {
      number,
      url,
      branch,
      title: readString(pr.title),
      state,
      checks_status: checksStatus,
      review_status: reviewStatus,
      head_sha: headSha,
      mergeable_state: readString(pr.mergeable_state),
      draft: readBoolean(pr.draft) ?? false,
      checked_at: new Date().toISOString(),
      summary: summarizeInspection(number, state, checksStatus, reviewStatus, headSha),
      checks,
      reviews,
      review_comments: reviewComments,
      issue_comments: issueComments,
      review_threads: reviewThreads
    };
    this.logger.info("github pr inspected", {
      pr_number: inspection.number,
      pr_url: inspection.url,
      state: inspection.state,
      checks_status: inspection.checks_status,
      review_status: inspection.review_status,
      head_sha: inspection.head_sha
    });
    return inspection;
  }

  async discoverOpen(): Promise<DiscoveredPullRequest[]> {
    return this.discoverManaged({ states: ["open"] });
  }

  async discoverManaged(options: PullRequestDiscoveryOptions = {}): Promise<DiscoveredPullRequest[]> {
    const config = this.getConfig().github;
    if (!config.owner || !config.repo) throw new SymphonyError("github_not_configured", "GitHub owner/repo are required for PR discovery");
    const branchPrefix = `${config.branch_prefix.replace(/\/+$/g, "")}/`;
    const states = normalizedDiscoveryStates(options.states);
    const discovered: DiscoveredPullRequest[] = [];
    const seen = new Set<number>();
    for (const state of states) {
      for (let page = 1; ; page += 1) {
        const payload = await this.api.request<unknown[]>(
          "GET",
          `/repos/${config.owner}/${config.repo}/pulls?state=${state}&base=${encodeURIComponent(config.base_branch)}&sort=updated&direction=desc&per_page=100&page=${page}`
        );
        const pulls = Array.isArray(payload) ? payload.filter((pr): pr is Record<string, unknown> => Boolean(pr) && typeof pr === "object") : [];
        for (const pr of pulls) {
          const branch = readNestedString(pr, ["head", "ref"]);
          if (!branch?.startsWith(branchPrefix)) continue;
          const issueIdentifier = inferIssueIdentifier(pr, branch, branchPrefix);
          if (!issueIdentifier) continue;
          const number = readNumber(pr.number, 0);
          const url = readString(pr.html_url);
          const title = readString(pr.title);
          if (!number || !url || !title || seen.has(number)) continue;
          seen.add(number);
          discovered.push({ number, url, branch, title, created: false, issue_identifier: issueIdentifier });
        }
        if (pulls.length < 100) break;
        if (state === "closed" && page >= CLOSED_PULL_REQUEST_RECOVERY_PAGE_LIMIT) break;
      }
    }
    this.logger.info("github prs discovered", { count: discovered.length, branch_prefix: branchPrefix, states });
    return discovered;
  }

  private async inspectChecks(headSha: string): Promise<PullRequestCheckSummary[]> {
    const config = this.getConfig().github;
    const checkRunsPayload = await this.api.request<Record<string, unknown>>("GET", `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`);
    const statusesPayload = await this.api.request<Record<string, unknown>>("GET", `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(headSha)}/status`);
    const runs = Array.isArray(checkRunsPayload.check_runs)
      ? checkRunsPayload.check_runs.filter((run): run is Record<string, unknown> => Boolean(run) && typeof run === "object")
      : [];
    const statuses = Array.isArray(statusesPayload.statuses)
      ? statusesPayload.statuses.filter((status): status is Record<string, unknown> => Boolean(status) && typeof status === "object")
      : [];
    return [
      ...runs.map((run) => ({
        name: readString(run.name) ?? "unnamed check",
        status: readString(run.status),
        conclusion: readString(run.conclusion),
        details_url: readString(run.details_url) ?? readString(run.html_url)
      })),
      ...statuses.map(readCommitStatusSummary)
    ];
  }

  private async inspectReviews(number: number): Promise<PullRequestReviewSummary[]> {
    const config = this.getConfig().github;
    const reviews = await this.api.request<unknown[]>("GET", `/repos/${config.owner}/${config.repo}/pulls/${number}/reviews?per_page=100`);
    return (Array.isArray(reviews) ? reviews : []).map(readReviewSummary).filter((review): review is PullRequestReviewSummary => Boolean(review));
  }

  private async inspectReviewComments(number: number): Promise<PullRequestReviewCommentSummary[]> {
    const config = this.getConfig().github;
    const comments = await this.api.request<unknown[]>("GET", `/repos/${config.owner}/${config.repo}/pulls/${number}/comments?per_page=100`);
    return (Array.isArray(comments) ? comments : []).map(readReviewCommentSummary).filter((comment): comment is PullRequestReviewCommentSummary => Boolean(comment));
  }

  private async inspectIssueComments(number: number): Promise<PullRequestIssueCommentSummary[]> {
    const config = this.getConfig().github;
    const comments = await this.api.request<unknown[]>("GET", `/repos/${config.owner}/${config.repo}/issues/${number}/comments?per_page=100`);
    return (Array.isArray(comments) ? comments : []).map(readIssueCommentSummary).filter((comment): comment is PullRequestIssueCommentSummary => Boolean(comment));
  }

  private async inspectReviewThreads(number: number): Promise<PullRequestReviewThreadSummary[]> {
    const config = this.getConfig().github;
    try {
      const payload = await this.api.graphql<Record<string, unknown>>(REVIEW_THREADS_QUERY, {
        owner: config.owner,
        repo: config.repo,
        number
      });
      const nodes = readNestedArray(payload, ["data", "repository", "pullRequest", "reviewThreads", "nodes"]);
      return nodes.map(readReviewThreadSummary).filter((thread): thread is PullRequestReviewThreadSummary => Boolean(thread));
    } catch (error) {
      this.logger.warn("github pr review thread inspection failed", { pr_number: number, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }
}

const CLOSED_PULL_REQUEST_RECOVERY_PAGE_LIMIT = 5;

const REVIEW_THREADS_QUERY = `
query SymphonyPullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes {
              author { login }
              body
              url
              createdAt
              updatedAt
              commit { oid }
            }
          }
        }
      }
    }
  }
}
`;

export function classifyCheckRuns(runs: PullRequestCheckSummary[]): PullRequestChecksStatus {
  if (runs.length === 0) return "unknown";
  let sawSuccessfulCompletion = false;
  for (const run of runs) {
    const status = run.status?.toLowerCase() ?? "unknown";
    const conclusion = run.conclusion?.toLowerCase() ?? null;
    if (status !== "completed") return "pending";
    if (!conclusion) return "pending";
    if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(conclusion)) return "failure";
    if (["success", "neutral", "skipped"].includes(conclusion)) sawSuccessfulCompletion = true;
  }
  return sawSuccessfulCompletion ? "success" : "unknown";
}

export function classifyReviews(reviews: PullRequestReviewSummary[]): PullRequestReviewStatus {
  const latestByReviewer = new Map<string, { state: string; submittedAt: number }>();
  for (const review of reviews) {
    const reviewer = review.reviewer;
    const submittedAt = review.submitted_at ? Date.parse(review.submitted_at) : 0;
    const state = review.state.toUpperCase();
    if (!state) continue;
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const existing = latestByReviewer.get(reviewer);
    if (!existing || submittedAt >= existing.submittedAt) latestByReviewer.set(reviewer, { state, submittedAt });
  }
  const latest = [...latestByReviewer.values()].map((review) => review.state);
  if (latest.some((state) => state === "CHANGES_REQUESTED")) return "changes_requested";
  if (latest.some((state) => state === "APPROVED")) return "approved";
  return "review_required";
}

function readReviewSummary(value: unknown): PullRequestReviewSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    reviewer: readNestedString(record, ["user", "login"]) ?? "unknown",
    state: readString(record.state)?.toUpperCase() ?? "UNKNOWN",
    submitted_at: readString(record.submitted_at),
    body: readString(record.body),
    url: readString(record.html_url),
    commit_id: readString(record.commit_id)
  };
}

function readReviewCommentSummary(value: unknown): PullRequestReviewCommentSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const body = readString(record.body);
  if (!body) return null;
  return {
    author: readNestedString(record, ["user", "login"]) ?? "unknown",
    path: readString(record.path),
    line: readNumberOrNull(record.line) ?? readNumberOrNull(record.original_line),
    body,
    url: readString(record.html_url),
    created_at: readString(record.created_at),
    updated_at: readString(record.updated_at),
    commit_id: readString(record.commit_id),
    original_commit_id: readString(record.original_commit_id)
  };
}

function readIssueCommentSummary(value: unknown): PullRequestIssueCommentSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const body = readString(record.body);
  if (!body || isSymphonyEvidenceComment(body)) return null;
  return {
    author: readNestedString(record, ["user", "login"]) ?? "unknown",
    body,
    url: readString(record.html_url),
    created_at: readString(record.created_at),
    updated_at: readString(record.updated_at)
  };
}

function readReviewThreadSummary(value: unknown): PullRequestReviewThreadSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) return null;
  const comments = readNestedArray(record, ["comments", "nodes"]).map(readReviewThreadCommentSummary).filter((comment): comment is NonNullable<typeof comment> => Boolean(comment));
  return {
    id,
    is_resolved: readBoolean(record.isResolved) ?? false,
    is_outdated: readBoolean(record.isOutdated) ?? false,
    path: readString(record.path),
    line: readNumberOrNull(record.line),
    comments
  };
}

function readReviewThreadCommentSummary(value: unknown): PullRequestReviewThreadSummary["comments"][number] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const body = readString(record.body);
  if (!body) return null;
  return {
    author: readNestedString(record, ["author", "login"]) ?? "unknown",
    body,
    url: readString(record.url),
    created_at: readString(record.createdAt),
    updated_at: readString(record.updatedAt),
    commit_id: readNestedString(record, ["commit", "oid"])
  };
}

function readCommitStatusSummary(status: Record<string, unknown>): PullRequestCheckSummary {
  const state = readString(status.state)?.toLowerCase() ?? "unknown";
  const completed = state === "pending" ? "pending" : "completed";
  const conclusion = state === "success" ? "success" : state === "failure" || state === "error" ? "failure" : null;
  return {
    name: readString(status.context) ?? "commit status",
    status: completed,
    conclusion,
    details_url: readString(status.target_url)
  };
}

export function inferIssueIdentifier(pr: Record<string, unknown>, branch: string, branchPrefix: string): string | null {
  const title = readString(pr.title);
  const body = readString(pr.body);
  for (const candidate of [title, body]) {
    const match = candidate?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  if (!branch.startsWith(branchPrefix)) return null;
  const slug = branch.slice(branchPrefix.length);
  const branchMatch = /^([a-z][a-z0-9]*)-(\d+)(?:-|$)/i.exec(slug);
  if (!branchMatch?.[1] || !branchMatch[2]) return null;
  return `${branchMatch[1].toUpperCase()}-${branchMatch[2]}`;
}

function normalizedDiscoveryStates(states: PullRequestDiscoveryState[] | undefined): PullRequestDiscoveryState[] {
  const requested = states && states.length > 0 ? states : ["open"];
  const out: PullRequestDiscoveryState[] = [];
  for (const state of requested) {
    if ((state === "open" || state === "closed") && !out.includes(state)) out.push(state);
  }
  return out.length > 0 ? out : ["open"];
}

function readLifecycleState(pr: Record<string, unknown>): PullRequestInspection["state"] {
  const merged = readBoolean(pr.merged) === true || typeof pr.merged_at === "string";
  if (merged) return "merged";
  return readString(pr.state)?.toLowerCase() === "closed" ? "closed" : "open";
}

function summarizeInspection(
  number: number,
  state: PullRequestInspection["state"],
  checksStatus: PullRequestChecksStatus,
  reviewStatus: PullRequestReviewStatus,
  headSha: string | null
): string {
  const sha = headSha ? ` at ${headSha.slice(0, 12)}` : "";
  return `PR #${number} is ${state}; checks=${checksStatus}; review=${reviewStatus}${sha}.`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNestedArray(record: Record<string, unknown>, path: string[]): unknown[] {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object") return [];
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : [];
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return readString(current);
}

function isSymphonyEvidenceComment(body: string): boolean {
  return body.includes(SYMPHONY_EVIDENCE_COMMENT_MARKER);
}

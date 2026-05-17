import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveConfig, type ConfigEnvironment, validateDispatchConfig } from "../config/config.js";
import type {
  DurableStateSnapshot,
  EvidenceManifest,
  Issue,
  PrReadyManifest,
  PublishedPullRequest,
  PullRequestEvidencePublication,
  PullRequestPublicationCheckpoint,
  SymphonyConfig,
  WorkflowDefinition
} from "../domain.js";
import { GitHubApiClient } from "../github/client.js";
import { GitHubPullRequestEvidencePublisher } from "../github/evidence.js";
import { branchName, GitHubPullRequestPublisher } from "../github/publisher.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { JsonDurableStateStore } from "../persistence/jsonStateStore.js";
import { LinearTrackerClient, normalizeIssue } from "../tracker/linear.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadWorkflow } from "../workflow/loader.js";

const execFileAsync = promisify(execFile);
export const LIVE_PUBLICATION_CANARY_FLAG = "TAKT_LIVE_PUBLICATION_CANARY";
export const LIVE_WORKFLOW_ENV = "TAKT_LIVE_WORKFLOW";
const DEFAULT_LIVE_WORKFLOW = "examples/WORKFLOW.md";

export const PUBLICATION_CANARY_FAILPOINTS = [
  "branch_pushed",
  "pull_request_published",
  "evidence_artifact_uploaded",
  "evidence_comment_published",
  "linear_comment_posted",
  "review_state_started",
  "review_state_reconciled"
] as const;

export type PublicationCanaryFailpoint = (typeof PUBLICATION_CANARY_FAILPOINTS)[number];

export type PublicationCanaryOptions = {
  enabled: boolean;
  help: boolean;
  workflowPath: string;
  failpoints: PublicationCanaryFailpoint[];
  keep: boolean;
  cleanupState: string | null;
  errors: string[];
};

type PublicationTransaction = {
  id: string;
  status: "in_progress" | "failed" | "completed" | "blocked";
  phase: string;
  started_at: string;
  updated_at: string;
  issue_id: string;
  issue_identifier: string;
  workspace_path: string | null;
  branch: string;
  manifest: PrReadyManifest;
  evidence_manifest?: EvidenceManifest | null;
  pull_request?: PublishedPullRequest;
  last_error?: string | null;
  attempts?: number;
  [key: string]: unknown;
};

type LinearProject = {
  id: string;
  name: string;
  team_id: string;
};

type CanaryRunResult = {
  failpoint: PublicationCanaryFailpoint;
  issue: Issue;
  pullRequest: PublishedPullRequest;
  evidenceUrl: string | null;
  publicationPhase: string;
  cleanup: "kept" | "completed";
};

type CanaryContext = {
  workflow: WorkflowDefinition;
  config: SymphonyConfig;
  logger: Logger;
  keep: boolean;
  cleanupState: string | null;
};

type SideEffectCheckpoint = {
  phase: string;
  tracked?: Record<string, unknown>;
  pullRequest?: PublishedPullRequest;
  evidence?: PullRequestEvidencePublication;
};

export function parsePublicationCanaryOptions(
  args: string[] = process.argv.slice(2),
  env: ConfigEnvironment = process.env,
  cwd = process.cwd()
): PublicationCanaryOptions {
  const errors: string[] = [];
  let help = false;
  let workflowPath: string | null = null;
  let keep = false;
  let cleanupState: string | null = null;
  const failpoints: PublicationCanaryFailpoint[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    if (arg === "--workflow") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) errors.push("--workflow requires a path");
      else {
        workflowPath = value;
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--workflow=")) {
      const value = arg.slice("--workflow=".length);
      if (!value) errors.push("--workflow requires a path");
      else workflowPath = value;
      continue;
    }
    if (arg === "--failpoint" || arg === "--failpoints") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) errors.push(`${arg} requires a comma-separated failpoint list`);
      else {
        failpoints.push(...parseFailpointList(value, errors));
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--failpoint=") || arg?.startsWith("--failpoints=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      if (!value) errors.push(`${arg.split("=")[0]} requires a comma-separated failpoint list`);
      else failpoints.push(...parseFailpointList(value, errors));
      continue;
    }
    if (arg === "--cleanup-state") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) errors.push("--cleanup-state requires a Linear workflow state name");
      else {
        cleanupState = value;
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--cleanup-state=")) {
      const value = arg.slice("--cleanup-state=".length);
      if (!value) errors.push("--cleanup-state requires a Linear workflow state name");
      else cleanupState = value;
      continue;
    }
    if (arg?.startsWith("-")) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (workflowPath) errors.push(`unexpected extra argument: ${arg}`);
    else workflowPath = arg ?? null;
  }

  return {
    enabled: env[LIVE_PUBLICATION_CANARY_FLAG] === "1",
    help,
    workflowPath: path.resolve(cwd, workflowPath ?? env[LIVE_WORKFLOW_ENV] ?? DEFAULT_LIVE_WORKFLOW),
    failpoints: uniqueFailpoints(failpoints.length > 0 ? failpoints : [...PUBLICATION_CANARY_FAILPOINTS]),
    keep,
    cleanupState,
    errors
  };
}

export function publicationCanaryUsage(): string {
  return [
    "Usage: pnpm integration:publication-canary -- [--workflow path] [--failpoints list] [--keep] [--cleanup-state name]",
    "",
    `By default this command reports SKIP. Set ${LIVE_PUBLICATION_CANARY_FLAG}=1 to create real Linear issues and GitHub draft PRs.`,
    `Failpoints: ${PUBLICATION_CANARY_FAILPOINTS.join(", ")}`,
    "",
    "Without --failpoints, the full matrix runs. Without --keep, each draft PR is closed, its branch is deleted, and the Linear issue is moved to an existing configured terminal cleanup state."
  ].join("\n");
}

export function selectPublicationCanaryCleanupState(
  terminalStates: string[],
  workflowStates: string[],
  requestedState: string | null = null
): string | null {
  const available = new Map(workflowStates.map((state) => [normalizeStateName(state), state]));
  if (requestedState) return available.get(normalizeStateName(requestedState)) ?? null;
  const configured = terminalStates.map((state) => available.get(normalizeStateName(state))).filter((state): state is string => Boolean(state));
  return configured.find((state) => /^cancell?ed$/i.test(state)) ?? configured[0] ?? null;
}

export async function main(args: string[] = process.argv.slice(2), env: ConfigEnvironment = process.env, cwd = process.cwd()): Promise<number> {
  const options = parsePublicationCanaryOptions(args, env, cwd);
  if (options.help) {
    console.log(publicationCanaryUsage());
    return 0;
  }
  if (!options.enabled) {
    console.log(`SKIPPED live publication canary: set ${LIVE_PUBLICATION_CANARY_FLAG}=1 to create real Linear issues and GitHub PRs`);
    return 0;
  }
  if (options.errors.length > 0) {
    for (const error of options.errors) console.error(error);
    return 1;
  }

  const workflow = await loadWorkflow(options.workflowPath);
  const baseConfig = resolveConfig(workflow, env);
  validateDispatchConfig(baseConfig);
  if (!baseConfig.github.enabled) throw new Error("github.enabled must be true for the live publication canary");
  if (!baseConfig.tracker.claim_state || !baseConfig.tracker.review_state) {
    throw new Error("tracker.claim_state and tracker.review_state are required for the live publication canary");
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "takt-live-publication-canary-"));
  const config = canaryConfig(baseConfig, tempRoot);
  const logger = createLogger();
  const cleanupState = options.keep ? null : await resolveCleanupState(config, options.cleanupState);
  const context: CanaryContext = { workflow, config, logger, keep: options.keep, cleanupState };
  const results: CanaryRunResult[] = [];

  console.log(`START live publication canary matrix: workflow=${options.workflowPath}`);
  console.log(`workspace_root=${config.workspace.root}`);
  console.log(`failpoints=${options.failpoints.join(",")}`);
  console.log(`cleanup=${options.keep ? "keep" : cleanupState ?? "(none)"}`);

  for (const failpoint of options.failpoints) {
    const result = await runFailpointCanary(context, failpoint);
    results.push(result);
    console.log(
      `PASS ${result.failpoint}: issue=${result.issue.url ?? result.issue.identifier} pr=${result.pullRequest.url} evidence=${result.evidenceUrl ?? "(none)"} cleanup=${result.cleanup}`
    );
  }

  console.log(`PASSED live publication canary matrix: ${results.length} failpoint${results.length === 1 ? "" : "s"}`);
  return 0;
}

async function runFailpointCanary(context: CanaryContext, failpoint: PublicationCanaryFailpoint): Promise<CanaryRunResult> {
  const issue = await createCanaryIssue(context.config, failpoint);
  const workspacePath = path.join(context.config.workspace.root, issue.identifier);
  const manifest = prReadyManifest(issue, failpoint);
  const evidenceManifest = evidenceForIssue(issue, failpoint);
  const branch = branchName(context.config.github.branch_prefix, issue);
  const durableStore = new JsonDurableStateStore(() => context.config, context.logger);
  let transaction = publicationTransaction(issue, workspacePath, branch, manifest, evidenceManifest, failpoint);
  let tracked: Record<string, unknown> = {};
  let pullRequest: PublishedPullRequest | null = null;
  let evidence: PullRequestEvidencePublication | null = null;

  try {
    await prepareWorkspace(context.config, issue, workspacePath, manifest, evidenceManifest);
    await saveTransaction(durableStore, issue, transaction, tracked);
    const publisher = new GitHubPullRequestPublisher(() => context.config, context.logger);

    if (failpoint === "branch_pushed" || failpoint === "pull_request_published") {
      const sideEffect = await publishUntilFailpoint(publisher, failpoint, issue, workspacePath, manifest, evidenceManifest, transaction, durableStore, tracked);
      transaction = sideEffect.transaction;
      pullRequest = sideEffect.pullRequest ?? readPullRequest(transaction.pull_request) ?? null;
    } else {
      pullRequest = await publisher.publish({
        issue,
        workspacePath,
        manifest,
        evidenceManifest,
        onCheckpoint: async (checkpoint) => {
          transaction = applyPublisherCheckpoint(transaction, checkpoint);
          await saveTransaction(durableStore, issue, transaction, tracked);
        }
      });
      transaction = await markFailedTransaction(durableStore, issue, transaction, "pull_request_recorded", "live canary prepared PR for side-effect failpoint", {
        pull_request: pullRequest
      }, tracked);
      tracked = { ...tracked, github_pull_request: pullRequest };
      const sideEffect = await performSideEffectsUntilFailpoint(context, failpoint, issue, workspacePath, pullRequest, evidenceManifest, durableStore, transaction, tracked);
      transaction = sideEffect.transaction;
      tracked = sideEffect.tracked;
      evidence = sideEffect.evidence ?? null;
    }

    const reconciliation = await reconcileFromLedger(context, durableStore, issue);
    pullRequest = reconciliation.pullRequest;
    evidence = reconciliation.evidence ?? evidence;
    transaction = reconciliation.transaction;

    if (transaction.status !== "completed") throw new Error(`publication transaction did not complete: ${transaction.status}`);
    const refreshed = await new LinearTrackerClient(() => context.config).fetchIssueStatesByIds([issue.id]);
    if (refreshed[0]?.state !== context.config.tracker.review_state) {
      throw new Error(`Linear issue was not moved to ${context.config.tracker.review_state}: ${refreshed[0]?.state ?? "(missing)"}`);
    }

    await cleanupCanary(context, issue, pullRequest, branch);
    return {
      failpoint,
      issue,
      pullRequest,
      evidenceUrl: evidence?.url ?? null,
      publicationPhase: transaction.phase,
      cleanup: context.keep ? "kept" : "completed"
    };
  } catch (error) {
    if (!context.keep) await cleanupCanary(context, issue, pullRequest, branch, { bestEffort: true }).catch(() => undefined);
    throw error;
  }
}

async function publishUntilFailpoint(
  publisher: GitHubPullRequestPublisher,
  failpoint: "branch_pushed" | "pull_request_published",
  issue: Issue,
  workspacePath: string,
  manifest: PrReadyManifest,
  evidenceManifest: EvidenceManifest,
  transaction: PublicationTransaction,
  durableStore: JsonDurableStateStore,
  tracked: Record<string, unknown>
): Promise<{ transaction: PublicationTransaction; pullRequest: PublishedPullRequest | null }> {
  let current = transaction;
  let reached = false;
  try {
    await publisher.publish({
      issue,
      workspacePath,
      manifest,
      evidenceManifest,
      onCheckpoint: async (checkpoint) => {
        current = applyPublisherCheckpoint(current, checkpoint);
        if (checkpoint.pullRequest) tracked.github_pull_request = checkpoint.pullRequest;
        await saveTransaction(durableStore, issue, current, tracked);
        if (checkpoint.phase === failpoint) {
          reached = true;
          current = await markFailedTransaction(durableStore, issue, current, checkpoint.phase, `live canary simulated crash after ${failpoint}`, {}, tracked);
          throw new Error(`live canary simulated crash after ${failpoint}`);
        }
      }
    });
  } catch (error) {
    if (!reached) throw error;
  }
  if (!reached) throw new Error(`canary did not reach failpoint ${failpoint}`);
  return { transaction: current, pullRequest: readPullRequest(current.pull_request) };
}

async function performSideEffectsUntilFailpoint(
  context: CanaryContext,
  failpoint: Exclude<PublicationCanaryFailpoint, "branch_pushed" | "pull_request_published">,
  issue: Issue,
  workspacePath: string,
  pullRequest: PublishedPullRequest,
  evidenceManifest: EvidenceManifest,
  durableStore: JsonDurableStateStore,
  transaction: PublicationTransaction,
  tracked: Record<string, unknown>
): Promise<SideEffectCheckpoint & { transaction: PublicationTransaction; tracked: Record<string, unknown> }> {
  let current = transaction;
  let currentTracked: Record<string, unknown> = { ...tracked, github_pull_request: pullRequest };
  let evidence: PullRequestEvidencePublication | null = null;

  if (failpoint === "evidence_artifact_uploaded") {
    await uploadCanaryArtifact(context.config, workspacePath, pullRequest.branch, issue);
    current = await markFailedTransaction(durableStore, issue, current, "evidence_artifact_uploaded", "live canary simulated crash after evidence artifact upload", {}, currentTracked);
    return { phase: "evidence_artifact_uploaded", transaction: current, tracked: currentTracked, pullRequest };
  }

  evidence = await publishEvidence(context, pullRequest, workspacePath, evidenceManifest, currentTracked);
  currentTracked = {
    ...currentTracked,
    github_evidence_comment_id: evidence.comment_id,
    github_evidence_comment_url: evidence.url,
    github_evidence_published_at: new Date().toISOString(),
    github_evidence_manifest: evidenceManifest,
    github_evidence_warnings: evidence.warnings
  };
  if (failpoint === "evidence_comment_published") {
    current = await markFailedTransaction(durableStore, issue, current, "evidence_published", "live canary simulated crash after evidence comment", {}, currentTracked);
    return { phase: "evidence_published", transaction: current, tracked: currentTracked, pullRequest, evidence };
  }

  const tracker = new LinearTrackerClient(() => context.config);
  await tracker.commentOnIssue(issue, `Published PR: ${pullRequest.url}`);
  if (failpoint === "linear_comment_posted") {
    current = await markFailedTransaction(durableStore, issue, current, "linear_comment_started", "live canary simulated crash after Linear PR comment", {}, currentTracked);
    return { phase: "linear_comment_started", transaction: current, tracked: currentTracked, pullRequest, evidence };
  }

  currentTracked = {
    ...currentTracked,
    github_pr_link_commented_number: pullRequest.number,
    github_pr_link_commented_url: pullRequest.url,
    github_pr_link_commented_at: new Date().toISOString()
  };
  if (failpoint === "review_state_started") {
    current = await markFailedTransaction(durableStore, issue, current, "review_state_started", "live canary simulated crash before review-state transition", {}, currentTracked);
    return { phase: "review_state_started", transaction: current, tracked: currentTracked, pullRequest, evidence };
  }

  await tracker.transitionIssue(issue, context.config.tracker.review_state ?? "Needs Human");
  current = await markFailedTransaction(durableStore, issue, current, "review_state_reconciled", "live canary simulated crash after review-state transition", {}, currentTracked);
  return { phase: "review_state_reconciled", transaction: current, tracked: currentTracked, pullRequest, evidence };
}

async function reconcileFromLedger(
  context: CanaryContext,
  durableStore: JsonDurableStateStore,
  issue: Issue
): Promise<{ pullRequest: PublishedPullRequest; evidence: PullRequestEvidencePublication | null; transaction: PublicationTransaction }> {
  const orchestrator = new Orchestrator({
    getConfig: () => context.config,
    getWorkflow: () => workflowForConfig(context.workflow, context.config),
    validateDispatch: async () => undefined,
    tracker: new LinearTrackerClient(() => context.config),
    workspaceManager: new WorkspaceManager(() => context.config, context.logger),
    pullRequestPublisher: new GitHubPullRequestPublisher(() => context.config, context.logger),
    pullRequestEvidencePublisher: new GitHubPullRequestEvidencePublisher(() => context.config, context.logger),
    durableStore,
    logger: context.logger
  });
  await orchestrator.start({ schedule: false });
  await orchestrator.reconcileOnce();
  const issueSnapshot = orchestrator.issueSnapshot(issue.identifier) as { tracked?: Record<string, unknown>; last_error?: string | null } | null;
  await orchestrator.stop();

  if (issueSnapshot?.last_error) throw new Error(`publication canary left last_error: ${issueSnapshot.last_error}`);
  const tracked = issueSnapshot?.tracked ?? {};
  const pullRequest = readPullRequest(tracked.github_pull_request);
  if (!pullRequest) throw new Error("publication canary did not record a GitHub pull request");
  const transaction = readTransaction(tracked.github_publication_transaction);
  if (!transaction) throw new Error("publication canary did not retain a publication transaction");
  const evidenceId = typeof tracked.github_evidence_comment_id === "number" ? tracked.github_evidence_comment_id : null;
  const evidenceUrl = typeof tracked.github_evidence_comment_url === "string" ? tracked.github_evidence_comment_url : null;
  return {
    pullRequest,
    evidence: evidenceId ? { comment_id: evidenceId, url: evidenceUrl, warnings: readStringArray(tracked.github_evidence_warnings) } : null,
    transaction
  };
}

function canaryConfig(config: SymphonyConfig, tempRoot: string): SymphonyConfig {
  return {
    ...config,
    github: {
      ...config.github,
      branch_prefix: "takt-canary",
      draft: true,
      merge: { ...config.github.merge, enabled: false }
    },
    workspace: { root: path.join(tempRoot, "workspaces") },
    server: { ...config.server, port: null }
  };
}

async function createCanaryIssue(config: SymphonyConfig, failpoint: PublicationCanaryFailpoint): Promise<Issue> {
  const project = await fetchProject(config);
  const claimStateId = await workflowStateId(config, project.team_id, config.tracker.claim_state ?? "In Progress");
  const nonce = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const mutation = `
    mutation TaktLivePublicationCanaryIssue($teamId: String!, $projectId: String!, $stateId: String!, $title: String!, $description: String!) {
      issueCreate(input: { teamId: $teamId, projectId: $projectId, stateId: $stateId, title: $title, description: $description }) {
        success
        issue { ${ISSUE_FIELDS} }
      }
    }
  `;
  const body = await linearGraphql(config, mutation, {
    teamId: project.team_id,
    projectId: project.id,
    stateId: claimStateId,
    title: `Live publication ledger canary ${failpoint} ${nonce}`,
    description: `Created by Takt livePublicationCanary to exercise crash-consistent PR publication reconciliation at failpoint ${failpoint}.`
  });
  if (valueAtPath(body, ["data", "issueCreate", "success"]) !== true) throw new Error("Linear issueCreate did not report success");
  return normalizeIssue(valueAtPath(body, ["data", "issueCreate", "issue"]));
}

async function fetchProject(config: SymphonyConfig): Promise<LinearProject> {
  const query = `
    query TaktLivePublicationCanaryProject($slug: String!) {
      projects(first: 1, filter: { slugId: { eq: $slug } }) {
        nodes { id name teams(first: 1) { nodes { id } } }
      }
    }
  `;
  const body = await linearGraphql(config, query, { slug: config.tracker.project_slug });
  const project = arrayAtPath(body, ["data", "projects", "nodes"])[0] as Record<string, unknown> | undefined;
  const team = arrayAtPath(project, ["teams", "nodes"])[0] as Record<string, unknown> | undefined;
  const id = stringAt(project, "id");
  const name = stringAt(project, "name") ?? "(unnamed)";
  const teamId = stringAt(team, "id");
  if (!id || !teamId) throw new Error("Linear project lookup did not return project/team ids");
  return { id, name, team_id: teamId };
}

async function workflowStateId(config: SymphonyConfig, teamId: string, stateName: string): Promise<string> {
  const query = `
    query TaktLivePublicationCanaryState($teamId: ID!, $name: String!) {
      workflowStates(first: 50, filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
        nodes { id name }
      }
    }
  `;
  const body = await linearGraphql(config, query, { teamId, name: stateName });
  const state = arrayAtPath(body, ["data", "workflowStates", "nodes"])[0] as Record<string, unknown> | undefined;
  const id = stringAt(state, "id");
  if (!id) throw new Error(`Linear workflow state not found: ${stateName}`);
  return id;
}

async function workflowStateNames(config: SymphonyConfig, teamId: string): Promise<string[]> {
  const query = `
    query TaktLivePublicationCanaryStates($teamId: ID!) {
      workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
        nodes { name }
      }
    }
  `;
  const body = await linearGraphql(config, query, { teamId });
  return arrayAtPath(body, ["data", "workflowStates", "nodes"])
    .map((node) => stringAt(node, "name"))
    .filter((name): name is string => Boolean(name));
}

async function resolveCleanupState(config: SymphonyConfig, requestedState: string | null): Promise<string | null> {
  const project = await fetchProject(config);
  const states = await workflowStateNames(config, project.team_id);
  const selected = selectPublicationCanaryCleanupState(config.tracker.terminal_states, states, requestedState);
  if (requestedState && !selected) throw new Error(`Linear cleanup state not found: ${requestedState}`);
  return selected;
}

async function prepareWorkspace(config: SymphonyConfig, issue: Issue, workspacePath: string, manifest: PrReadyManifest, evidence: EvidenceManifest): Promise<void> {
  await mkdir(path.dirname(workspacePath), { recursive: true });
  await execFileAsync("git", ["clone", `https://github.com/${config.github.owner}/${config.github.repo}.git`, workspacePath]);
  await git(workspacePath, ["config", "user.name", "Takt Canary"]);
  await git(workspacePath, ["config", "user.email", "takt-canary@example.invalid"]);
  await writeFile(
    path.join(workspacePath, "LIVE_PUBLICATION_CANARY.md"),
    [`# Live Publication Canary`, "", `Linear: ${issue.url ?? issue.identifier}`, `Created: ${new Date().toISOString()}`, ""].join("\n")
  );
  await git(workspacePath, ["add", "LIVE_PUBLICATION_CANARY.md"]);
  await git(workspacePath, ["commit", "-m", `${issue.identifier}: live publication ledger canary`]);
  const artifactDir = path.join(workspacePath, "artifacts", issue.identifier);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "ledger-canary.txt"), `Live publication ledger canary for ${issue.identifier}\n`);
  await writeFile(path.join(workspacePath, config.github.pr_ready_file), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(workspacePath, config.github.evidence_file), `${JSON.stringify(evidence, null, 2)}\n`);
}

function prReadyManifest(issue: Issue, failpoint: PublicationCanaryFailpoint): PrReadyManifest {
  return {
    title: `${issue.identifier}: Live publication ledger canary ${failpoint}`,
    summary: `Exercises crash-consistent PR publication by simulating a restart at ${failpoint}.`,
    verification: ["TAKT_LIVE_PUBLICATION_CANARY=1 pnpm integration:publication-canary"],
    risk: "Creates draft canary PRs and moves dedicated Linear canary issues through review before cleanup."
  };
}

function evidenceForIssue(issue: Issue, failpoint: PublicationCanaryFailpoint): EvidenceManifest {
  return {
    summary: `The live publication canary resumed from failpoint ${failpoint}.`,
    verification: [`failpoint ${failpoint} reached`, "publication transaction reconciled after restart"],
    commands: [{ kind: "canary", status: "succeeded", command: "pnpm integration:publication-canary" }],
    artifacts: [{ kind: "log", path: `artifacts/${issue.identifier}/ledger-canary.txt`, description: "Canary marker uploaded from an uncommitted artifact path." }],
    notes: "This is intentionally generated by the Takt live publication canary."
  };
}

function publicationTransaction(
  issue: Issue,
  workspacePath: string,
  branch: string,
  manifest: PrReadyManifest,
  evidence: EvidenceManifest,
  failpoint: PublicationCanaryFailpoint
): PublicationTransaction {
  const now = new Date().toISOString();
  return {
    id: `${issue.id}:live-publication-canary:${failpoint}`,
    status: "in_progress",
    phase: "started",
    started_at: now,
    updated_at: now,
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    workspace_path: workspacePath,
    branch,
    manifest,
    evidence_manifest: evidence,
    last_error: null,
    attempts: 1
  };
}

async function saveTransaction(
  store: JsonDurableStateStore,
  issue: Issue,
  transaction: PublicationTransaction,
  tracked: Record<string, unknown> = {}
): Promise<void> {
  await store.save(snapshotFor(issue, transaction, tracked));
}

async function markFailedTransaction(
  store: JsonDurableStateStore,
  issue: Issue,
  transaction: PublicationTransaction,
  phase: string,
  message: string,
  updates: Partial<PublicationTransaction> = {},
  tracked: Record<string, unknown> = {}
): Promise<PublicationTransaction> {
  const failed: PublicationTransaction = {
    ...transaction,
    ...updates,
    status: "failed",
    phase,
    last_error: message,
    updated_at: new Date().toISOString()
  };
  await saveTransaction(store, issue, failed, tracked);
  return failed;
}

function snapshotFor(issue: Issue, transaction: PublicationTransaction, tracked: Record<string, unknown> = {}): DurableStateSnapshot {
  return {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    retry_attempts: [],
    completed_issue_ids: [],
    issue_history: [
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: transaction.workspace_path,
        restart_count: 0,
        last_error: transaction.last_error ?? null,
        run_attempts: [],
        recent_events: [],
        tracked: { ...tracked, github_publication_transaction: transaction }
      }
    ],
    recent_events: [],
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    codex_rate_limits: null
  };
}

function applyPublisherCheckpoint(transaction: PublicationTransaction, checkpoint: PullRequestPublicationCheckpoint): PublicationTransaction {
  return {
    ...transaction,
    phase: checkpoint.phase,
    updated_at: checkpoint.at ?? new Date().toISOString(),
    ...(checkpoint.branch ? { branch: checkpoint.branch } : {}),
    ...(checkpoint.operation ? { operation: checkpoint.operation } : {}),
    ...(checkpoint.pullRequest ? { pull_request: checkpoint.pullRequest } : {}),
    [`${checkpoint.phase}_at`]: checkpoint.at ?? new Date().toISOString()
  };
}

async function publishEvidence(
  context: CanaryContext,
  pullRequest: PublishedPullRequest,
  workspacePath: string,
  manifest: EvidenceManifest,
  tracked: Record<string, unknown>
): Promise<PullRequestEvidencePublication> {
  const previousCommentId = typeof tracked.github_evidence_comment_id === "number" ? tracked.github_evidence_comment_id : null;
  return await new GitHubPullRequestEvidencePublisher(() => context.config, context.logger).publish({
    pullRequest,
    workspacePath,
    manifest,
    previousCommentId
  });
}

async function uploadCanaryArtifact(config: SymphonyConfig, workspacePath: string, branch: string, issue: Issue): Promise<void> {
  const owner = config.github.owner;
  const repo = config.github.repo;
  if (!owner || !repo) throw new Error("GitHub owner/repo are required");
  const repositoryPath = `artifacts/${issue.identifier}/ledger-canary.txt`;
  const content = await readFile(path.join(workspacePath, repositoryPath));
  await new GitHubApiClient(() => config).request("PUT", `/repos/${owner}/${repo}/contents/${repositoryPath}`, {
    message: `Add Takt canary evidence artifact ${repositoryPath}`,
    content: content.toString("base64"),
    branch
  });
}

async function cleanupCanary(
  context: CanaryContext,
  issue: Issue,
  pullRequest: PublishedPullRequest | null,
  branch: string,
  options: { bestEffort?: boolean } = {}
): Promise<void> {
  if (context.keep) return;
  const errors: string[] = [];
  const cleanupStep = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}: ${message}`);
      context.logger.warn(`publication canary ${label} cleanup failed`, { issue_identifier: issue.identifier, error: message });
    }
  };
  const github = new GitHubApiClient(() => context.config);
  const owner = context.config.github.owner;
  const repo = context.config.github.repo;
  if (owner && repo && pullRequest) {
    await cleanupStep("PR", async () => {
      await github.request("PATCH", `/repos/${owner}/${repo}/pulls/${pullRequest.number}`, { state: "closed" });
    });
  }
  if (owner && repo) {
    await cleanupStep("branch", async () => {
      await github.request("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${encodeBranchRef(branch)}`);
    });
  }
  if (context.cleanupState) {
    await cleanupStep("Linear", async () => {
      await new LinearTrackerClient(() => context.config).transitionIssue(issue, context.cleanupState ?? "");
    });
  }
  if (errors.length > 0 && !options.bestEffort) throw new Error(`publication canary cleanup failed: ${errors.join("; ")}`);
}

async function linearGraphql(config: SymphonyConfig, query: string, variables: Record<string, unknown>): Promise<unknown> {
  if (!config.tracker.api_key) throw new Error("Linear API key is missing");
  const response = await fetch(config.tracker.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.tracker.api_key
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
  if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors)) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify((body as { errors: unknown }).errors).slice(0, 500)}`);
  }
  return body;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function workflowForConfig(workflow: WorkflowDefinition, config: SymphonyConfig): WorkflowDefinition {
  return { ...workflow, path: config.workflowPath };
}

function parseFailpointList(value: string, errors: string[]): PublicationCanaryFailpoint[] {
  const failpoints: PublicationCanaryFailpoint[] = [];
  for (const raw of value.split(",")) {
    const failpoint = raw.trim();
    if (!failpoint) continue;
    if (isPublicationCanaryFailpoint(failpoint)) failpoints.push(failpoint);
    else errors.push(`unknown failpoint: ${failpoint}`);
  }
  return failpoints;
}

function isPublicationCanaryFailpoint(value: string): value is PublicationCanaryFailpoint {
  return (PUBLICATION_CANARY_FAILPOINTS as readonly string[]).includes(value);
}

function uniqueFailpoints(values: PublicationCanaryFailpoint[]): PublicationCanaryFailpoint[] {
  const seen = new Set<PublicationCanaryFailpoint>();
  const out: PublicationCanaryFailpoint[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readPullRequest(value: unknown): PublishedPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number" || typeof record.url !== "string" || typeof record.branch !== "string" || typeof record.title !== "string") return null;
  return { number: record.number, url: record.url, branch: record.branch, title: record.title, created: record.created === true };
}

function readTransaction(value: unknown): PublicationTransaction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.status !== "string" || typeof record.phase !== "string") return null;
  if (record.status !== "in_progress" && record.status !== "failed" && record.status !== "completed" && record.status !== "blocked") return null;
  return record as PublicationTransaction;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function valueAtPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function arrayAtPath(value: unknown, pathParts: string[]): unknown[] {
  const valueAt = pathParts.length === 0 ? value : valueAtPath(value, pathParts);
  return Array.isArray(valueAt) ? valueAt : [];
}

function stringAt(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" && child.length > 0 ? child : null;
}

function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function encodeBranchRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { relatedIssue { id identifier state { name } } } }
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}

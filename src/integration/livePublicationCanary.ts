import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveConfig, type ConfigEnvironment, validateDispatchConfig } from "../config/config.js";
import type { DurableStateSnapshot, EvidenceManifest, Issue, PrReadyManifest, PublishedPullRequest, SymphonyConfig, WorkflowDefinition } from "../domain.js";
import { GitHubPullRequestEvidencePublisher } from "../github/evidence.js";
import { branchName, GitHubPullRequestPublisher } from "../github/publisher.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createLogger } from "../observability/logger.js";
import { JsonDurableStateStore } from "../persistence/jsonStateStore.js";
import { LinearTrackerClient, normalizeIssue } from "../tracker/linear.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { loadWorkflow } from "../workflow/loader.js";

const execFileAsync = promisify(execFile);
const LIVE_PUBLICATION_CANARY_FLAG = "TAKT_LIVE_PUBLICATION_CANARY";
const LIVE_WORKFLOW_ENV = "TAKT_LIVE_WORKFLOW";
const DEFAULT_LIVE_WORKFLOW = "examples/WORKFLOW.md";

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

export async function main(args: string[] = process.argv.slice(2), env: ConfigEnvironment = process.env, cwd = process.cwd()): Promise<number> {
  if (env[LIVE_PUBLICATION_CANARY_FLAG] !== "1") {
    console.log(`SKIPPED live publication canary: set ${LIVE_PUBLICATION_CANARY_FLAG}=1 to create a real Linear issue and GitHub PR`);
    return 0;
  }
  const workflowPath = path.resolve(cwd, parseWorkflowArg(args) ?? env[LIVE_WORKFLOW_ENV] ?? DEFAULT_LIVE_WORKFLOW);
  const workflow = await loadWorkflow(workflowPath);
  const baseConfig = resolveConfig(workflow, env);
  validateDispatchConfig(baseConfig);
  if (!baseConfig.github.enabled) throw new Error("github.enabled must be true for the live publication canary");
  if (!baseConfig.tracker.claim_state || !baseConfig.tracker.review_state) {
    throw new Error("tracker.claim_state and tracker.review_state are required for the live publication canary");
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "takt-live-publication-canary-"));
  const config = canaryConfig(baseConfig, tempRoot);
  const logger = createLogger();

  console.log(`START live publication canary: workflow=${workflowPath}`);
  console.log(`workspace_root=${config.workspace.root}`);
  const issue = await createCanaryIssue(config);
  const workspacePath = path.join(config.workspace.root, issue.identifier);
  const manifest = prReadyManifest(issue);
  const evidenceManifest = evidenceForIssue(issue);
  const branch = branchName(config.github.branch_prefix, issue);
  await prepareWorkspace(config, issue, workspacePath, manifest, evidenceManifest);

  const durableStore = new JsonDurableStateStore(() => config, logger);
  let transaction = publicationTransaction(issue, workspacePath, branch, manifest, evidenceManifest);
  await durableStore.save(snapshotFor(issue, transaction));

  const publisher = new GitHubPullRequestPublisher(() => config, logger);
  let simulatedCrash = false;
  try {
    await publisher.publish({
      issue,
      workspacePath,
      manifest,
      evidenceManifest,
      onCheckpoint: async (checkpoint) => {
        transaction = {
          ...transaction,
          phase: checkpoint.phase,
          updated_at: checkpoint.at ?? new Date().toISOString(),
          ...(checkpoint.branch ? { branch: checkpoint.branch } : {}),
          ...(checkpoint.operation ? { operation: checkpoint.operation } : {}),
          ...(checkpoint.pullRequest ? { pull_request: checkpoint.pullRequest } : {}),
          [`${checkpoint.phase}_at`]: checkpoint.at ?? new Date().toISOString()
        };
        await durableStore.save(snapshotFor(issue, transaction));
        if (checkpoint.phase === "branch_pushed") {
          simulatedCrash = true;
          transaction = {
            ...transaction,
            status: "failed",
            last_error: "live canary simulated crash after branch push",
            updated_at: new Date().toISOString()
          };
          await durableStore.save(snapshotFor(issue, transaction));
          throw new Error("live canary simulated crash after branch push");
        }
      }
    });
  } catch (error) {
    if (!simulatedCrash) throw error;
  }
  if (!simulatedCrash) throw new Error("canary did not reach the branch_pushed failpoint");

  const orchestrator = new Orchestrator({
    getConfig: () => config,
    getWorkflow: () => workflowForConfig(workflow, config),
    validateDispatch: async () => undefined,
    tracker: new LinearTrackerClient(() => config),
    workspaceManager: new WorkspaceManager(() => config, logger),
    pullRequestPublisher: new GitHubPullRequestPublisher(() => config, logger),
    pullRequestEvidencePublisher: new GitHubPullRequestEvidencePublisher(() => config, logger),
    durableStore,
    logger
  });
  await orchestrator.start({ schedule: false });
  await orchestrator.reconcileOnce();
  const issueSnapshot = orchestrator.issueSnapshot(issue.identifier) as { tracked?: Record<string, unknown>; last_error?: string | null } | null;
  await orchestrator.stop();

  const tracked = issueSnapshot?.tracked ?? {};
  const pullRequest = readPullRequest(tracked.github_pull_request);
  if (!pullRequest) throw new Error("publication canary did not record a GitHub pull request");
  const publication = tracked.github_publication_transaction as Record<string, unknown> | undefined;
  if (publication?.status !== "completed") throw new Error(`publication transaction did not complete: ${String(publication?.status)}`);
  if (issueSnapshot?.last_error) throw new Error(`publication canary left last_error: ${issueSnapshot.last_error}`);
  const refreshed = await new LinearTrackerClient(() => config).fetchIssueStatesByIds([issue.id]);
  if (refreshed[0]?.state !== config.tracker.review_state) {
    throw new Error(`Linear issue was not moved to ${config.tracker.review_state}: ${refreshed[0]?.state ?? "(missing)"}`);
  }

  console.log("PASSED live publication canary");
  console.log(`linear_issue=${issue.url ?? issue.identifier}`);
  console.log(`pull_request=${pullRequest.url}`);
  console.log(`evidence_comment=${String(tracked.github_evidence_comment_url ?? "(none)")}`);
  console.log(`publication_phase=${String(publication.phase)}`);
  return 0;
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

async function createCanaryIssue(config: SymphonyConfig): Promise<Issue> {
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
    title: `Live publication ledger canary ${nonce}`,
    description: "Created by Takt livePublicationCanary to exercise crash-consistent PR publication reconciliation."
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

function prReadyManifest(issue: Issue): PrReadyManifest {
  return {
    title: `${issue.identifier}: Live publication ledger canary`,
    summary: "Exercises crash-consistent PR publication by simulating a restart after branch push.",
    verification: ["TAKT_LIVE_PUBLICATION_CANARY=1 node --import tsx src/integration/livePublicationCanary.ts"],
    risk: "Creates a draft canary PR and moves a dedicated Linear canary issue to review."
  };
}

function evidenceForIssue(issue: Issue): EvidenceManifest {
  return {
    summary: "The live publication canary resumed from a branch-pushed durable transaction.",
    verification: ["branch push failpoint reached", "publication transaction reconciled after restart"],
    commands: [{ kind: "canary", status: "succeeded", command: "node --import tsx src/integration/livePublicationCanary.ts" }],
    artifacts: [{ kind: "log", path: `artifacts/${issue.identifier}/ledger-canary.txt`, description: "Canary marker uploaded from an uncommitted artifact path." }],
    notes: "This is intentionally generated by the Takt live publication canary."
  };
}

function publicationTransaction(
  issue: Issue,
  workspacePath: string,
  branch: string,
  manifest: PrReadyManifest,
  evidence: EvidenceManifest
): PublicationTransaction {
  const now = new Date().toISOString();
  return {
    id: `${issue.id}:live-publication-canary`,
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

function snapshotFor(issue: Issue, transaction: PublicationTransaction): DurableStateSnapshot {
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
        tracked: { github_publication_transaction: transaction }
      }
    ],
    recent_events: [],
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    codex_rate_limits: null
  };
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

function parseWorkflowArg(args: string[]): string | null {
  const index = args.findIndex((arg) => arg === "--workflow");
  if (index >= 0) return args[index + 1] ?? null;
  const prefixed = args.find((arg) => arg.startsWith("--workflow="));
  if (prefixed) return prefixed.slice("--workflow=".length);
  return args.find((arg) => !arg.startsWith("-")) ?? null;
}

function readPullRequest(value: unknown): PublishedPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number" || typeof record.url !== "string" || typeof record.branch !== "string" || typeof record.title !== "string") return null;
  return { number: record.number, url: record.url, branch: record.branch, title: record.title, created: record.created === true };
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

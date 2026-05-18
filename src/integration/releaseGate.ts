import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveConfig, type ConfigEnvironment, validateDispatchConfig } from "../config/config.js";
import type { Issue, SymphonyConfig } from "../domain.js";
import { SymphonyError, errorMessage } from "../errors.js";
import { GitHubApiClient } from "../github/client.js";
import { LinearTrackerClient } from "../tracker/linear.js";
import { loadWorkflow } from "../workflow/loader.js";
import { LIVE_INTEGRATION_FLAG, LIVE_WORKFLOW_ENV, redactKnownSecrets } from "./liveProfile.js";
import {
  LIVE_PUBLICATION_CANARY_FLAG,
  PUBLICATION_CANARY_FAILPOINTS,
  type PublicationCanaryFailpoint
} from "./livePublicationCanary.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKFLOW = "examples/WORKFLOW.md";
const DEFAULT_REPORT_PATH = ".takt/release-gate/latest.json";

export const RELEASE_LIVE_FLAG = "TAKT_RELEASE_LIVE";
export const RELEASE_CANARY_FLAG = "TAKT_RELEASE_CANARY";
export const RELEASE_FULL_CANARY_FLAG = "TAKT_RELEASE_FULL_CANARY";

export type ReleaseGateStatus = "passed" | "failed" | "skipped";

export type ReleaseGatePlan = {
  help: boolean;
  workflowPath: string;
  reportPath: string | null;
  json: boolean;
  verify: boolean;
  allowDirty: boolean;
  live: boolean;
  canary: boolean;
  fullCanary: boolean;
  canaryFailpoints: PublicationCanaryFailpoint[];
  errors: string[];
};

export type ReleaseGateCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: ConfigEnvironment;
};

export type ReleaseGateCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ReleaseGateStep = {
  name: "commit" | "worktree" | "local_verify" | "live_preflight" | "publication_canary" | "residue_check";
  status: ReleaseGateStatus;
  message: string;
  command?: string[];
  duration_ms?: number;
  stdout_tail?: string;
  stderr_tail?: string;
};

export type ReleaseGateCanaryArtifact = {
  failpoint: string;
  issue_identifier: string | null;
  issue_url: string | null;
  pr_number: number | null;
  pr_url: string | null;
  evidence_url: string | null;
  cleanup: string | null;
};

export type ReleaseGateGitHubResidue = {
  pr_number: number;
  pr_url: string | null;
  state: string | null;
  head_ref: string | null;
  branch_exists: boolean | null;
};

export type ReleaseGateLinearResidue = {
  issue_identifier: string;
  state: string | null;
  terminal: boolean;
};

export type ReleaseGateResidueCheck = {
  status: ReleaseGateStatus;
  message: string;
  github_prs: ReleaseGateGitHubResidue[];
  linear_issues: ReleaseGateLinearResidue[];
};

export type ReleaseGateReport = {
  schema_version: 1;
  status: ReleaseGateStatus;
  started_at: string;
  completed_at: string | null;
  commit: string | null;
  workflow_path: string;
  allow_dirty: boolean;
  live_enabled: boolean;
  canary_enabled: boolean;
  canary_failpoints: string[];
  steps: ReleaseGateStep[];
  canary_artifacts: ReleaseGateCanaryArtifact[];
  residue_check: ReleaseGateResidueCheck | null;
  report_path: string | null;
};

export type ReleaseGateDependencies = {
  commandRunner?: (command: ReleaseGateCommand) => Promise<ReleaseGateCommandResult>;
  residueVerifier?: (input: {
    workflowPath: string;
    env: ConfigEnvironment;
    artifacts: ReleaseGateCanaryArtifact[];
  }) => Promise<ReleaseGateResidueCheck>;
  writeReport?: (reportPath: string, report: ReleaseGateReport) => Promise<void>;
  now?: () => Date;
};

type ParsedReleaseGateArgs = {
  help: boolean;
  workflowPath: string | null;
  reportPath: string | null;
  noReport: boolean;
  json: boolean;
  verify: boolean;
  allowDirty: boolean;
  live: boolean | null;
  canary: boolean | null;
  fullCanary: boolean | null;
  canaryFailpoints: PublicationCanaryFailpoint[];
  errors: string[];
};

export function buildReleaseGatePlan(
  args: string[] = process.argv.slice(2),
  env: ConfigEnvironment = process.env,
  cwd = process.cwd()
): ReleaseGatePlan {
  const parsed = parseReleaseGateArgs(args);
  const live = parsed.live ?? isEnabled(env[RELEASE_LIVE_FLAG]);
  const fullCanary = parsed.fullCanary ?? isEnabled(env[RELEASE_FULL_CANARY_FLAG]);
  const canary = parsed.canary ?? (fullCanary || isEnabled(env[RELEASE_CANARY_FLAG]));
  const workflowValue = parsed.workflowPath ?? env[LIVE_WORKFLOW_ENV] ?? DEFAULT_WORKFLOW;
  const canaryFailpoints: PublicationCanaryFailpoint[] =
    parsed.canaryFailpoints.length > 0 ? uniqueFailpoints(parsed.canaryFailpoints) : fullCanary ? [...PUBLICATION_CANARY_FAILPOINTS] : ["branch_pushed"];

  return {
    help: parsed.help,
    workflowPath: path.resolve(cwd, workflowValue),
    reportPath: parsed.noReport ? null : path.resolve(cwd, parsed.reportPath ?? DEFAULT_REPORT_PATH),
    json: parsed.json,
    verify: parsed.verify,
    allowDirty: parsed.allowDirty,
    live,
    canary,
    fullCanary,
    canaryFailpoints,
    errors: parsed.errors
  };
}

export async function runReleaseGate(
  plan: ReleaseGatePlan,
  env: ConfigEnvironment = process.env,
  cwd = process.cwd(),
  dependencies: ReleaseGateDependencies = {}
): Promise<ReleaseGateReport> {
  const now = dependencies.now ?? (() => new Date());
  const commandRunner = dependencies.commandRunner ?? runCommand;
  const report: ReleaseGateReport = {
    schema_version: 1,
    status: "passed",
    started_at: now().toISOString(),
    completed_at: null,
    commit: null,
    workflow_path: plan.workflowPath,
    allow_dirty: plan.allowDirty,
    live_enabled: plan.live,
    canary_enabled: plan.canary,
    canary_failpoints: plan.canaryFailpoints,
    steps: [],
    canary_artifacts: [],
    residue_check: null,
    report_path: plan.reportPath
  };

  if (plan.errors.length > 0) {
    report.status = "failed";
    report.steps.push({ name: "commit", status: "failed", message: plan.errors.join("; ") });
    report.completed_at = now().toISOString();
    await maybeWriteReport(plan, report, dependencies);
    return report;
  }

  const commit = await runGateCommand("commit", ["git", "rev-parse", "HEAD"], commandRunner, env, cwd);
  report.steps.push(commit.step);
  if (commit.step.status === "passed") report.commit = commit.result.stdout.trim() || null;
  else report.status = "failed";

  if (report.status === "passed") {
    const worktree = await runGateCommand("worktree", ["git", "status", "--porcelain"], commandRunner, env, cwd);
    const dirty = worktree.result.stdout.trim().length > 0;
    report.steps.push({
      ...worktree.step,
      status: dirty && !plan.allowDirty ? "failed" : "passed",
      message: dirty ? (plan.allowDirty ? "worktree has uncommitted changes; allowed by --allow-dirty" : "worktree has uncommitted changes") : "worktree is clean"
    });
    if (dirty && !plan.allowDirty) report.status = "failed";
  }

  if (report.status === "passed" && plan.verify) {
    const verify = await runGateCommand("local_verify", ["pnpm", "verify"], commandRunner, env, cwd);
    report.steps.push(verify.step);
    if (verify.step.status !== "passed") report.status = "failed";
  } else if (report.status === "passed" && !plan.verify) {
    report.steps.push({ name: "local_verify", status: "skipped", message: "local verify was skipped by option" });
  }

  if (report.status === "passed") {
    if (plan.live) {
      const live = await runGateCommand(
        "live_preflight",
        ["pnpm", "integration:live", "--", "--workflow", plan.workflowPath],
        commandRunner,
        { ...env, [LIVE_INTEGRATION_FLAG]: "1" },
        cwd
      );
      report.steps.push(live.step);
      if (live.step.status !== "passed") report.status = "failed";
    } else {
      report.steps.push({ name: "live_preflight", status: "skipped", message: `set ${RELEASE_LIVE_FLAG}=1 or pass --live to run non-mutating live checks` });
    }
  }

  if (report.status === "passed") {
    if (plan.canary) {
      const canaryArgs = [
        "pnpm",
        "integration:publication-canary",
        "--",
        "--workflow",
        plan.workflowPath,
        "--failpoints",
        plan.canaryFailpoints.join(",")
      ];
      const canary = await runGateCommand("publication_canary", canaryArgs, commandRunner, { ...env, [LIVE_PUBLICATION_CANARY_FLAG]: "1" }, cwd);
      report.steps.push(canary.step);
      report.canary_artifacts = parsePublicationCanaryArtifacts(canary.result.stdout);
      if (canary.step.status !== "passed") report.status = "failed";
    } else {
      report.steps.push({ name: "publication_canary", status: "skipped", message: `set ${RELEASE_CANARY_FLAG}=1 or pass --canary to run a mutating publication canary` });
    }
  }

  if (report.status === "passed" && plan.canary) {
    const verifier = dependencies.residueVerifier ?? verifyCanaryResidue;
    try {
      const residue = await verifier({ workflowPath: plan.workflowPath, env, artifacts: report.canary_artifacts });
      report.residue_check = residue;
      report.steps.push({ name: "residue_check", status: residue.status, message: residue.message });
      if (residue.status !== "passed") report.status = "failed";
    } catch (error) {
      const message = redactKnownSecrets(errorMessage(error), env);
      report.residue_check = { status: "failed", message, github_prs: [], linear_issues: [] };
      report.steps.push({ name: "residue_check", status: "failed", message });
      report.status = "failed";
    }
  } else if (report.status === "passed" && !plan.canary) {
    report.steps.push({ name: "residue_check", status: "skipped", message: "canary residue check requires a canary run" });
  }

  report.completed_at = now().toISOString();
  await maybeWriteReport(plan, report, dependencies);
  return report;
}

export function formatReleaseGateReport(report: ReleaseGateReport): string[] {
  const lines = [`${report.status.toUpperCase()} release gate: ${report.workflow_path}`];
  lines.push(`commit: ${report.commit ?? "(unknown)"}`);
  lines.push(`report: ${report.report_path ?? "(not written)"}`);
  for (const step of report.steps) lines.push(`${step.status.toUpperCase()} ${step.name}: ${step.message}`);
  if (report.canary_artifacts.length > 0) {
    lines.push(`canary artifacts: ${report.canary_artifacts.length}`);
    for (const artifact of report.canary_artifacts) {
      lines.push(
        `- ${artifact.failpoint}: issue=${artifact.issue_identifier ?? artifact.issue_url ?? "(unknown)"} pr=${artifact.pr_number ?? artifact.pr_url ?? "(unknown)"} cleanup=${artifact.cleanup ?? "(unknown)"}`
      );
    }
  }
  return lines;
}

export function releaseGateUsage(): string {
  return [
    "Usage: pnpm release:gate -- [--workflow path] [--live] [--canary|--full-canary] [--failpoints list] [--json] [--report path] [--allow-dirty]",
    "",
    "By default this requires a clean worktree, runs pnpm verify, skips live checks, and writes .takt/release-gate/latest.json.",
    `Set ${RELEASE_LIVE_FLAG}=1 or pass --live to run the non-mutating Linear/GitHub readiness profile.`,
    `Set ${RELEASE_CANARY_FLAG}=1 or pass --canary to run the mutating branch_pushed publication canary.`,
    `Set ${RELEASE_FULL_CANARY_FLAG}=1 or pass --full-canary to run the full publication canary matrix.`,
    "",
    `Failpoints: ${PUBLICATION_CANARY_FAILPOINTS.join(", ")}`
  ].join("\n");
}

export function parsePublicationCanaryArtifacts(stdout: string): ReleaseGateCanaryArtifact[] {
  const artifacts: ReleaseGateCanaryArtifact[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^PASS\s+([^:]+):\s+issue=(\S+)\s+pr=(\S+)\s+evidence=(\S+)\s+cleanup=(\S+)/.exec(line.trim());
    if (!match) continue;
    const [, failpoint, issue, pr, evidence, cleanup] = match;
    artifacts.push({
      failpoint: failpoint ?? "",
      issue_identifier: issueIdentifierFromValue(issue ?? ""),
      issue_url: issue && issue !== "(none)" ? issue : null,
      pr_number: pullRequestNumberFromValue(pr ?? ""),
      pr_url: pr && pr !== "(none)" ? pr : null,
      evidence_url: evidence && evidence !== "(none)" ? evidence : null,
      cleanup: cleanup && cleanup !== "(none)" ? cleanup : null
    });
  }
  return artifacts;
}

async function runGateCommand(
  name: ReleaseGateStep["name"],
  commandLine: string[],
  commandRunner: (command: ReleaseGateCommand) => Promise<ReleaseGateCommandResult>,
  env: ConfigEnvironment,
  cwd: string
): Promise<{ step: ReleaseGateStep; result: ReleaseGateCommandResult }> {
  const started = Date.now();
  const [command, ...args] = commandLine;
  if (!command) throw new Error("release gate command was empty");
  const result = await commandRunner({ command, args, cwd, env });
  const duration = Date.now() - started;
  const passed = result.exitCode === 0;
  return {
    result,
    step: {
      name,
      status: passed ? "passed" : "failed",
      message: passed ? commandLine.join(" ") : `${commandLine.join(" ")} exited ${result.exitCode}`,
      command: commandLine,
      duration_ms: duration,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    }
  };
}

async function runCommand(command: ReleaseGateCommand): Promise<ReleaseGateCommandResult> {
  try {
    const result = await execFileAsync(command.command, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      maxBuffer: 20 * 1024 * 1024
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const record = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    const exitCode = typeof record.code === "number" ? record.code : 1;
    return {
      exitCode,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : errorMessage(error)
    };
  }
}

async function verifyCanaryResidue(input: {
  workflowPath: string;
  env: ConfigEnvironment;
  artifacts: ReleaseGateCanaryArtifact[];
}): Promise<ReleaseGateResidueCheck> {
  if (input.artifacts.length === 0) {
    return { status: "failed", message: "publication canary did not report any artifacts", github_prs: [], linear_issues: [] };
  }
  const workflow = await loadWorkflow(input.workflowPath);
  const config = resolveConfig(workflow, input.env);
  validateDispatchConfig(config);
  const githubPrs = await verifyGitHubCanaryResidue(config, input.artifacts);
  const linearIssues = await verifyLinearCanaryResidue(config, input.artifacts);
  const badPrs = githubPrs.filter((item) => item.state !== "closed" || item.branch_exists !== false);
  const badIssues = linearIssues.filter((item) => !item.terminal);
  const status: ReleaseGateStatus = badPrs.length === 0 && badIssues.length === 0 ? "passed" : "failed";
  return {
    status,
    message:
      status === "passed"
        ? `verified ${githubPrs.length} PR cleanup result${githubPrs.length === 1 ? "" : "s"} and ${linearIssues.length} Linear cleanup state${linearIssues.length === 1 ? "" : "s"}`
        : `canary residue remains: ${badPrs.length} PR/branch issue${badPrs.length === 1 ? "" : "s"}, ${badIssues.length} Linear issue${badIssues.length === 1 ? "" : "s"}`,
    github_prs: githubPrs,
    linear_issues: linearIssues
  };
}

async function verifyGitHubCanaryResidue(config: SymphonyConfig, artifacts: ReleaseGateCanaryArtifact[]): Promise<ReleaseGateGitHubResidue[]> {
  const api = new GitHubApiClient(() => config);
  const owner = config.github.owner;
  const repo = config.github.repo;
  if (!owner || !repo) throw new Error("github owner/repo are required for canary residue checks");
  const out: ReleaseGateGitHubResidue[] = [];
  for (const number of uniqueNumbers(artifacts.map((artifact) => artifact.pr_number))) {
    const payload = await api.request<Record<string, unknown>>("GET", `/repos/${owner}/${repo}/pulls/${number}`);
    const head = payload.head && typeof payload.head === "object" ? (payload.head as Record<string, unknown>) : null;
    const headRef = typeof head?.ref === "string" ? head.ref : null;
    out.push({
      pr_number: number,
      pr_url: typeof payload.html_url === "string" ? payload.html_url : null,
      state: typeof payload.state === "string" ? payload.state : null,
      head_ref: headRef,
      branch_exists: headRef ? await githubBranchExists(api, owner, repo, headRef) : null
    });
  }
  return out;
}

async function githubBranchExists(api: GitHubApiClient, owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    await api.request("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodeBranchRef(branch)}`);
    return true;
  } catch (error) {
    if (githubStatus(error) === 404) return false;
    throw error;
  }
}

async function verifyLinearCanaryResidue(config: SymphonyConfig, artifacts: ReleaseGateCanaryArtifact[]): Promise<ReleaseGateLinearResidue[]> {
  const identifiers = uniqueStrings(artifacts.map((artifact) => artifact.issue_identifier));
  if (identifiers.length === 0) return [];
  const issues = await new LinearTrackerClient(() => config).fetchIssuesByIdentifiers(identifiers);
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier.toUpperCase(), issue]));
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeStateName));
  return identifiers.map((identifier) => {
    const issue = byIdentifier.get(identifier.toUpperCase()) as Issue | undefined;
    const state = issue?.state ?? null;
    return { issue_identifier: identifier, state, terminal: state ? terminalStates.has(normalizeStateName(state)) : false };
  });
}

async function maybeWriteReport(
  plan: ReleaseGatePlan,
  report: ReleaseGateReport,
  dependencies: ReleaseGateDependencies
): Promise<void> {
  if (!plan.reportPath) return;
  const writer = dependencies.writeReport ?? writeJsonReport;
  await writer(plan.reportPath, report);
}

async function writeJsonReport(reportPath: string, report: ReleaseGateReport): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseReleaseGateArgs(args: string[]): ParsedReleaseGateArgs {
  const parsed: ParsedReleaseGateArgs = {
    help: false,
    workflowPath: null,
    reportPath: null,
    noReport: false,
    json: false,
    verify: true,
    allowDirty: false,
    live: null,
    canary: null,
    fullCanary: null,
    canaryFailpoints: [],
    errors: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--no-report") {
      parsed.noReport = true;
      continue;
    }
    if (arg === "--skip-verify") {
      parsed.verify = false;
      continue;
    }
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (arg === "--live") {
      parsed.live = true;
      continue;
    }
    if (arg === "--no-live") {
      parsed.live = false;
      continue;
    }
    if (arg === "--canary") {
      parsed.canary = true;
      continue;
    }
    if (arg === "--no-canary") {
      parsed.canary = false;
      continue;
    }
    if (arg === "--full-canary") {
      parsed.canary = true;
      parsed.fullCanary = true;
      continue;
    }
    if (arg === "--workflow" || arg === "--report" || arg === "--failpoint" || arg === "--failpoints") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) parsed.errors.push(`${arg} requires a value`);
      else {
        applyOptionValue(parsed, arg, value);
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--workflow=") || arg?.startsWith("--report=") || arg?.startsWith("--failpoint=") || arg?.startsWith("--failpoints=")) {
      const option = arg.slice(0, arg.indexOf("="));
      const value = arg.slice(arg.indexOf("=") + 1);
      if (!value) parsed.errors.push(`${option} requires a value`);
      else applyOptionValue(parsed, option, value);
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (parsed.workflowPath) parsed.errors.push(`unexpected extra argument: ${arg}`);
    else parsed.workflowPath = arg ?? null;
  }
  return parsed;
}

function applyOptionValue(parsed: ParsedReleaseGateArgs, option: string, value: string): void {
  if (option === "--workflow") parsed.workflowPath = value;
  else if (option === "--report") parsed.reportPath = value;
  else if (option === "--failpoint" || option === "--failpoints") parsed.canaryFailpoints.push(...parseFailpoints(value, parsed.errors));
}

function parseFailpoints(value: string, errors: string[]): PublicationCanaryFailpoint[] {
  const out: PublicationCanaryFailpoint[] = [];
  for (const raw of value.split(",")) {
    const failpoint = raw.trim();
    if (!failpoint) continue;
    if ((PUBLICATION_CANARY_FAILPOINTS as readonly string[]).includes(failpoint)) out.push(failpoint as PublicationCanaryFailpoint);
    else errors.push(`unknown canary failpoint: ${failpoint}`);
  }
  return out;
}

function issueIdentifierFromValue(value: string): string | null {
  const match = /\b[A-Z]+-\d+\b/.exec(value);
  return match?.[0] ?? null;
}

function pullRequestNumberFromValue(value: string): number | null {
  const match = /\/pull\/(\d+)\b/.exec(value);
  const number = match ? Number(match[1]) : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function tail(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function uniqueFailpoints(values: PublicationCanaryFailpoint[]): PublicationCanaryFailpoint[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: Array<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === "number"))];
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function encodeBranchRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function githubStatus(error: unknown): number | null {
  if (!(error instanceof SymphonyError)) return null;
  const cause = error.causeValue;
  if (!cause || typeof cause !== "object") return null;
  const status = (cause as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

export async function main(args: string[] = process.argv.slice(2), env: ConfigEnvironment = process.env, cwd = process.cwd()): Promise<number> {
  const plan = buildReleaseGatePlan(args, env, cwd);
  if (plan.help) {
    console.log(releaseGateUsage());
    return 0;
  }
  const report = await runReleaseGate(plan, env, cwd);
  if (plan.json) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatReleaseGateReport(report)) console.log(line);
  return report.status === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(redactKnownSecrets(errorMessage(error)));
      process.exitCode = 1;
    }
  );
}

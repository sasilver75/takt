import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, type ConfigEnvironment, validateDispatchConfig } from "../config/config.js";
import type { SymphonyConfig, WorkflowDefinition } from "../domain.js";
import { GitHubApiClient, type GitHubMethod, type FetchLike } from "../github/client.js";
import { LinearTrackerClient } from "../tracker/linear.js";
import { loadWorkflow } from "../workflow/loader.js";

export const LIVE_INTEGRATION_FLAG = "SYMPHONY_LIVE_INTEGRATION";
export const LIVE_WORKFLOW_ENV = "SYMPHONY_LIVE_WORKFLOW";
const DEFAULT_LIVE_WORKFLOW = "examples/WORKFLOW.md";

export type LiveIntegrationPlan = {
  enabled: boolean;
  help: boolean;
  workflowPath: string;
  argumentErrors: string[];
  skipReason: string | null;
};

export type LiveIntegrationCheckStatus = "passed" | "failed" | "skipped";

export type LiveIntegrationCheck = {
  name: string;
  status: LiveIntegrationCheckStatus;
  message: string;
};

export type LiveIntegrationProfileResult = {
  status: LiveIntegrationCheckStatus;
  workflowPath: string;
  checks: LiveIntegrationCheck[];
  message: string;
};

export type LiveIntegrationProfileDependencies = {
  env?: ConfigEnvironment;
  fetchImpl?: FetchLike;
  loadWorkflow?: (workflowPath: string) => Promise<WorkflowDefinition>;
  linearClientFactory?: (config: SymphonyConfig) => Pick<LinearTrackerClient, "fetchCandidateIssues">;
  githubClientFactory?: (config: SymphonyConfig) => { request(method: GitHubMethod, route: string, body?: unknown): Promise<unknown> };
};

type ParsedArgs = {
  help: boolean;
  workflowPath: string | null;
  errors: string[];
};

export function buildLiveIntegrationPlan(
  args: string[] = process.argv.slice(2),
  env: ConfigEnvironment = process.env,
  cwd = process.cwd()
): LiveIntegrationPlan {
  const parsed = parseArgs(args);
  const workflowValue = parsed.workflowPath ?? env[LIVE_WORKFLOW_ENV] ?? DEFAULT_LIVE_WORKFLOW;
  const enabled = isEnabled(env[LIVE_INTEGRATION_FLAG]);
  return {
    enabled,
    help: parsed.help,
    workflowPath: path.resolve(cwd, workflowValue),
    argumentErrors: parsed.errors,
    skipReason: enabled ? null : `set ${LIVE_INTEGRATION_FLAG}=1 to run live Linear/GitHub checks`
  };
}

export async function runLiveIntegrationProfile(
  plan: LiveIntegrationPlan,
  dependencies: LiveIntegrationProfileDependencies = {}
): Promise<LiveIntegrationProfileResult> {
  const env = dependencies.env ?? process.env;
  if (!plan.enabled) {
    return {
      status: "skipped",
      workflowPath: plan.workflowPath,
      checks: [],
      message: plan.skipReason ?? `set ${LIVE_INTEGRATION_FLAG}=1 to run live checks`
    };
  }

  if (plan.argumentErrors.length > 0) {
    return {
      status: "failed",
      workflowPath: plan.workflowPath,
      checks: plan.argumentErrors.map((error) => ({ name: "arguments", status: "failed", message: error })),
      message: "live integration profile arguments are invalid"
    };
  }

  const checks: LiveIntegrationCheck[] = [];
  const loader = dependencies.loadWorkflow ?? loadWorkflow;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  let workflow: WorkflowDefinition;
  try {
    workflow = await loader(plan.workflowPath);
    checks.push({ name: "workflow load", status: "passed", message: plan.workflowPath });
  } catch (error) {
    return failResult(plan.workflowPath, checks, "workflow load", error, env);
  }

  let config: SymphonyConfig;
  try {
    config = resolveConfig(workflow, env);
    validateDispatchConfig(config);
    checks.push({
      name: "dispatch config",
      status: "passed",
      message: `tracker=${config.tracker.kind} project=${config.tracker.project_slug ?? "(none)"} github=${config.github.enabled ? `${config.github.owner}/${config.github.repo}` : "disabled"}`
    });
  } catch (error) {
    return failResult(plan.workflowPath, checks, "dispatch config", error, env);
  }

  try {
    const linearClient =
      dependencies.linearClientFactory?.(config) ?? new LinearTrackerClient(() => config, fetchImpl);
    const issues = await linearClient.fetchCandidateIssues();
    checks.push({
      name: "linear candidate read",
      status: "passed",
      message: `read ${issues.length} candidate issue${issues.length === 1 ? "" : "s"} from project ${config.tracker.project_slug ?? "(none)"}`
    });
  } catch (error) {
    return failResult(plan.workflowPath, checks, "linear candidate read", error, env);
  }

  if (!config.github.enabled) {
    checks.push({ name: "github repo read", status: "skipped", message: "github.enabled is false in workflow config" });
    return {
      status: "passed",
      workflowPath: plan.workflowPath,
      checks,
      message: "live integration profile passed"
    };
  }

  try {
    const githubClient =
      dependencies.githubClientFactory?.(config) ?? new GitHubApiClient(() => config, fetchImpl);
    await githubClient.request("GET", `/repos/${encodeURIComponent(config.github.owner ?? "")}/${encodeURIComponent(config.github.repo ?? "")}`);
    checks.push({
      name: "github repo read",
      status: "passed",
      message: `read repository metadata for ${config.github.owner}/${config.github.repo}`
    });
  } catch (error) {
    return failResult(plan.workflowPath, checks, "github repo read", error, env);
  }

  return {
    status: "passed",
    workflowPath: plan.workflowPath,
    checks,
    message: "live integration profile passed"
  };
}

export function formatLiveIntegrationResult(result: LiveIntegrationProfileResult): string[] {
  const lines = [`${result.status.toUpperCase()} real integration profile: ${result.message}`];
  lines.push(`workflow: ${result.workflowPath}`);
  for (const check of result.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  return lines;
}

export function redactKnownSecrets(text: string, env: ConfigEnvironment = process.env): string {
  let redacted = text;
  const secretEntries = Object.entries(env)
    .filter(([key, value]) => Boolean(value) && String(value).length >= 8 && /(TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER|CREDENTIAL)/i.test(key))
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [key, value] of secretEntries) {
    redacted = redacted.split(String(value)).join(`[REDACTED:${key}]`);
  }
  return redacted;
}

export async function main(args: string[] = process.argv.slice(2), env: ConfigEnvironment = process.env, cwd = process.cwd()): Promise<number> {
  const plan = buildLiveIntegrationPlan(args, env, cwd);
  if (plan.help) {
    console.log(usage());
    return 0;
  }
  const result = await runLiveIntegrationProfile(plan, { env });
  for (const line of formatLiveIntegrationResult(result)) console.log(line);
  return result.status === "failed" ? 1 : 0;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, workflowPath: null, errors: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--workflow") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        parsed.errors.push("--workflow requires a path");
      } else {
        parsed.workflowPath = value;
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith("--workflow=")) {
      const value = arg.slice("--workflow=".length);
      if (!value) parsed.errors.push("--workflow requires a path");
      else parsed.workflowPath = value;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (parsed.workflowPath) {
      parsed.errors.push(`unexpected extra argument: ${arg}`);
    } else {
      parsed.workflowPath = arg ?? null;
    }
  }
  return parsed;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function failResult(
  workflowPath: string,
  checks: LiveIntegrationCheck[],
  name: string,
  error: unknown,
  env: ConfigEnvironment
): LiveIntegrationProfileResult {
  return {
    status: "failed",
    workflowPath,
    checks: [...checks, { name, status: "failed", message: redactKnownSecrets(errorMessage(error), env) }],
    message: "live integration profile failed"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return [
    "Usage: pnpm integration:live -- [--workflow path-to-WORKFLOW.md]",
    "",
    `By default this command reports SKIP. Set ${LIVE_INTEGRATION_FLAG}=1 to run the non-mutating live profile.`,
    `If no workflow is supplied, ${LIVE_WORKFLOW_ENV} is used, then ${DEFAULT_LIVE_WORKFLOW}.`,
    "",
    "Checks: workflow load, dispatch config validation, Linear candidate read, and GitHub repo metadata read when github.enabled is true."
  ].join("\n");
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

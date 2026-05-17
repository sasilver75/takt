import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigEnvironment } from "../config/config.js";
import { resolveConfig, validateDispatchConfig } from "../config/config.js";
import type { Issue, SymphonyConfig, WorkflowDefinition } from "../domain.js";
import { errorMessage } from "../errors.js";
import { loadWorkflow } from "../workflow/loader.js";
import { renderIssuePrompt } from "../workflow/prompt.js";

const execFileAsync = promisify(execFile);

export type DoctorSeverity = "ok" | "warning" | "error";

export type DoctorCheck = {
  severity: DoctorSeverity;
  area: string;
  message: string;
  action?: string;
};

export type WorkflowDoctorReport = {
  workflowPath: string;
  ok: boolean;
  checks: DoctorCheck[];
};

export type WorkflowDoctorOptions = {
  workflowPath: string;
  env?: ConfigEnvironment;
  dockerImageExists?: (image: string) => Promise<boolean | null>;
};

export async function runWorkflowDoctor(options: WorkflowDoctorOptions): Promise<WorkflowDoctorReport> {
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  let workflow: WorkflowDefinition;
  try {
    workflow = await loadWorkflow(options.workflowPath);
    checks.push(ok("workflow", `Parsed ${workflow.path}`));
  } catch (error) {
    checks.push(failure("workflow", `Failed to load workflow: ${errorMessage(error)}`, "Fix the workflow path, YAML front matter, or file permissions."));
    return report(options.workflowPath, checks);
  }

  for (const ref of collectEnvRefs(workflow)) {
    if (env[ref.name]?.trim()) checks.push(ok("environment", `${ref.name} is set for ${ref.path}`));
    else checks.push(failure("environment", `${ref.name} is required by ${ref.path}`, `Export ${ref.name} or update ${ref.path} in WORKFLOW.md.`));
  }

  let config: SymphonyConfig;
  try {
    config = resolveConfig(workflow, env);
    checks.push(ok("config", "Resolved typed workflow config"));
  } catch (error) {
    checks.push(failure("config", `Failed to resolve config: ${errorMessage(error)}`, "Fix the typed workflow fields called out in this error."));
    return report(workflow.path, checks);
  }

  try {
    validateDispatchConfig(config);
    checks.push(ok("dispatch", "Dispatch preflight config is valid"));
  } catch (error) {
    checks.push(failure("dispatch", `Dispatch preflight failed: ${errorMessage(error)}`, "Fix required Linear, GitHub, runtime, or handoff-manifest config before running Takt."));
  }

  addTargetChecks(config, checks);
  addLinearChecks(config, checks);
  addGitHubChecks(config, workflow, checks);
  await addRuntimeChecks(config, checks, options.dockerImageExists ?? defaultDockerImageExists);
  addHookChecks(config, checks);
  await addPromptCheck(workflow, config, checks);

  return report(workflow.path, checks);
}

export function formatWorkflowDoctorReport(report: WorkflowDoctorReport): string {
  const counts = {
    errors: report.checks.filter((check) => check.severity === "error").length,
    warnings: report.checks.filter((check) => check.severity === "warning").length,
    ok: report.checks.filter((check) => check.severity === "ok").length
  };
  const lines = [`Takt workflow validation: ${report.workflowPath}`];
  for (const check of report.checks) {
    lines.push(`[${check.severity.toUpperCase()}] ${check.area}: ${check.message}`);
    if (check.action) lines.push(`  action: ${check.action}`);
  }
  lines.push(`Summary: ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.ok} ok check(s)`);
  return `${lines.join("\n")}\n`;
}

function addTargetChecks(config: SymphonyConfig, checks: DoctorCheck[]): void {
  const target = config.target;
  if (!target) {
    checks.push(warning("target", "No target metadata is configured", "Add a target section with name, kind, repository, verification, evidence, and handoff expectations."));
    return;
  }
  if (target.name) checks.push(ok("target", `Target name is ${target.name}`));
  else checks.push(warning("target", "target.name is missing", "Set target.name so operators can see which application this Takt instance owns."));
  if (target.kind) checks.push(ok("target", `Target kind is ${target.kind}`));
  else checks.push(warning("target", "target.kind is missing", "Set target.kind to a descriptive profile such as typescript-web, go-service, or ios-host."));
  if (target.repository) checks.push(ok("target", `Target repository is ${target.repository}`));
  else checks.push(warning("target", "target.repository is missing", "Set target.repository to the canonical GitHub repository identifier."));
  if (target.verification.length > 0) checks.push(ok("target", `Target declares ${target.verification.length} verification expectation(s)`));
  else checks.push(warning("target", "target.verification is empty", "List the commands that should normally prove a worker change is ready for review."));
  if (!target.handoff) checks.push(warning("target", "target.handoff is missing", "Describe the expected handoff, usually a GitHub PR in tracker.review_state."));
}

function addLinearChecks(config: SymphonyConfig, checks: DoctorCheck[]): void {
  checks.push(ok("linear", `Using Linear project slug ${config.tracker.project_slug ?? "(missing)"}`));
  if (config.tracker.claim_state) checks.push(ok("linear", `Claim state is ${config.tracker.claim_state}`));
  else checks.push(warning("linear", "tracker.claim_state is missing", "Set tracker.claim_state so Takt can reserve work before launching a worker."));
  if (config.tracker.review_state) checks.push(ok("linear", `Review state is ${config.tracker.review_state}`));
  else checks.push(warning("linear", "tracker.review_state is missing", "Set tracker.review_state so Takt can move published PRs to human review."));
}

function addGitHubChecks(config: SymphonyConfig, workflow: WorkflowDefinition, checks: DoctorCheck[]): void {
  if (!config.github.enabled) {
    checks.push(warning("github", "GitHub PR publishing is disabled", "Enable github.enabled for the standard Linear issue -> GitHub PR loop."));
    return;
  }
  checks.push(ok("github", `Publishing PRs to ${config.github.owner ?? "(missing)"}/${config.github.repo ?? "(missing)"}`));
  if (config.target?.repository && config.github.owner && config.github.repo) {
    const expected = `${config.github.owner}/${config.github.repo}`.toLowerCase();
    if (config.target.repository.toLowerCase().includes(expected)) {
      checks.push(ok("github", "target.repository matches github.owner/repo"));
    } else {
      checks.push(warning("github", "target.repository does not appear to match github.owner/repo", "Confirm the target metadata and GitHub PR publisher point at the same repository."));
    }
  }
  const rawGitHub = objectAt(workflow.config, "github");
  if (rawGitHub.token === undefined) {
    checks.push(warning("github", "github.token is not declared in WORKFLOW.md", "Use github.token: $GITHUB_TOKEN so required credentials are explicit."));
  }
  checks.push(ok("github", `PR handoff manifest is ${config.github.pr_ready_file}`));
  checks.push(ok("github", `Evidence manifest is ${config.github.evidence_file}`));
}

async function addRuntimeChecks(
  config: SymphonyConfig,
  checks: DoctorCheck[],
  dockerImageExists: (image: string) => Promise<boolean | null>
): Promise<void> {
  const targetLooksApple = isAppleHostTarget(config);
  if (config.runtime.kind === "host") {
    checks.push(ok("runtime", "Using host runtime"));
    if (targetLooksApple) {
      checks.push(warning("runtime", "Host runtime must be validated on a macOS/Xcode machine", "Run this doctor command on the intended host and confirm xcodebuild/simulator access before production use."));
    } else {
      checks.push(warning("runtime", "Host runtime executes directly on the operator machine", "Confirm this is intentional; Docker gives a narrower default worker boundary for most non-Apple targets."));
    }
    return;
  }

  checks.push(ok("runtime", `Using Docker runtime image ${config.runtime.docker.image}`));
  if (targetLooksApple) {
    checks.push(failure("runtime", "Apple/Xcode-style target is configured with Docker runtime", "Use runtime.kind: host on a macOS/Xcode worker, or add a macOS remote runtime before running iOS/macOS work."));
  }
  const exists = await dockerImageExists(config.runtime.docker.image);
  if (exists === true) checks.push(ok("runtime", `Docker image ${config.runtime.docker.image} exists locally`));
  else if (exists === false) {
    checks.push(failure("runtime", `Docker image ${config.runtime.docker.image} was not found locally`, dockerBuildHint(config)));
  } else {
    checks.push(warning("runtime", "Docker image presence could not be checked", "Install/start Docker and rerun the doctor command on the worker host."));
  }
}

function dockerBuildHint(config: SymphonyConfig): string {
  const dockerfile = config.runtime.kind === "docker" && /go/i.test(config.runtime.docker.image) ? "docker/codex-worker-go.Dockerfile" : "docker/codex-worker.Dockerfile";
  const image = config.runtime.kind === "docker" ? config.runtime.docker.image : "takt-codex-worker:latest";
  return `Build it first, for example: docker build -f ${dockerfile} -t ${image} .`;
}

function addHookChecks(config: SymphonyConfig, checks: DoctorCheck[]): void {
  if (config.hooks.after_create) {
    checks.push(ok("hooks", "after_create hook is configured"));
    if (!/\bgit\s+clone\b/.test(config.hooks.after_create)) {
      checks.push(warning("hooks", "after_create does not appear to clone a repository", "Confirm this workflow has another way to populate the issue workspace."));
    }
  } else {
    checks.push(warning("hooks", "after_create hook is missing", "Add an after_create hook to clone or bootstrap the target repository."));
  }

  if (config.hooks.before_run) {
    checks.push(ok("hooks", "before_run hook is configured"));
    if (!/\bgit\s+(fetch|pull|rebase)\b/.test(config.hooks.before_run)) {
      checks.push(warning("hooks", "before_run does not appear to sync the repository", "Add an explicit fetch/rebase/pull step or document why reused workspaces do not need sync."));
    }
  } else {
    checks.push(warning("hooks", "before_run hook is missing", "Add a before_run hook to sync the repo and install dependencies before each worker attempt."));
  }
}

async function addPromptCheck(workflow: WorkflowDefinition, config: SymphonyConfig, checks: DoctorCheck[]): Promise<void> {
  try {
    const rendered = await renderIssuePrompt(workflow, sampleIssue(), null, null, config.target);
    checks.push(ok("prompt", `Rendered sample prompt (${rendered.length} characters)`));
  } catch (error) {
    checks.push(failure("prompt", `Sample prompt rendering failed: ${errorMessage(error)}`, "Fix unknown Liquid variables/filters or malformed prompt syntax before dispatch."));
  }
}

function collectEnvRefs(workflow: WorkflowDefinition): Array<{ path: string; name: string }> {
  const refs = envRefsFromValue(workflow.config);
  const tracker = objectAt(workflow.config, "tracker");
  if (tracker.api_key === undefined) refs.push({ path: "tracker.api_key", name: "LINEAR_API_KEY" });
  return dedupeRefs(refs);
}

function envRefsFromValue(value: unknown, path = ""): Array<{ path: string; name: string }> {
  if (typeof value === "string") {
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    return match?.[1] ? [{ path: path || "(root)", name: match[1] }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => envRefsFromValue(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => envRefsFromValue(entry, path ? `${path}.${key}` : key));
}

function dedupeRefs(refs: Array<{ path: string; name: string }>): Array<{ path: string; name: string }> {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.path}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function defaultDockerImageExists(image: string): Promise<boolean | null> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return null;
      if (code === 1) return false;
    }
    return null;
  }
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isAppleHostTarget(config: SymphonyConfig): boolean {
  const targetText = [
    config.target?.kind,
    config.target?.description,
    ...(config.target?.instructions ?? []),
    ...(config.target?.verification ?? [])
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return /\b(ios|macos|xcode|xcodebuild|swift)\b/.test(targetText);
}

function sampleIssue(): Issue {
  return {
    id: "doctor-sample-issue",
    identifier: "DOCTOR-1",
    title: "Validate target workflow",
    description: "Sample issue used to validate prompt rendering.",
    priority: 3,
    state: "Ready",
    branch_name: null,
    url: "https://linear.example/DOCTOR-1",
    labels: ["doctor"],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
}

function report(workflowPath: string, checks: DoctorCheck[]): WorkflowDoctorReport {
  return {
    workflowPath,
    ok: checks.every((check) => check.severity !== "error"),
    checks
  };
}

function ok(area: string, message: string): DoctorCheck {
  return { severity: "ok", area, message };
}

function warning(area: string, message: string, action: string): DoctorCheck {
  return { severity: "warning", area, message, action };
}

function failure(area: string, message: string, action: string): DoctorCheck {
  return { severity: "error", area, message, action };
}

import os from "node:os";
import path from "node:path";
import type { SymphonyConfig, WorkflowDefinition } from "../domain.js";
import { SymphonyError } from "../errors.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export type ConfigEnvironment = Record<string, string | undefined>;

export function resolveConfig(
  workflow: WorkflowDefinition,
  env: ConfigEnvironment = process.env,
  overrides: { port?: number | null } = {}
): SymphonyConfig {
  const root = workflow.config;
  const tracker = objectAt(root, "tracker");
  const github = objectAt(root, "github");
  const githubMerge = objectAt(github, "merge");
  const polling = objectAt(root, "polling");
  const workspace = objectAt(root, "workspace");
  const runtime = objectAt(root, "runtime");
  const dockerRuntime = objectAt(runtime, "docker");
  const hooks = objectAt(root, "hooks");
  const agent = objectAt(root, "agent");
  const codex = objectAt(root, "codex");
  const linearGraphqlMcp = objectAt(codex, "linear_graphql_mcp");
  const observability = objectAt(root, "observability");
  const server = objectAt(root, "server");
  const workflowDir = path.dirname(workflow.path);
  const trackerKind = stringAt(tracker, "kind") ?? "linear";

  return {
    workflowPath: workflow.path,
    workflowDir,
    tracker: {
      kind: trackerKind === "linear" ? "linear" : (trackerKind as "linear"),
      endpoint: stringAt(tracker, "endpoint") ?? "https://api.linear.app/graphql",
      api_key: resolveSecret(stringAt(tracker, "api_key") ?? "$LINEAR_API_KEY", env),
      project_slug: emptyToNull(stringAt(tracker, "project_slug")),
      active_states: stringListAt(tracker, "active_states", DEFAULT_ACTIVE_STATES),
      terminal_states: stringListAt(tracker, "terminal_states", DEFAULT_TERMINAL_STATES),
      claim_state: emptyToNull(stringAt(tracker, "claim_state")),
      review_state: emptyToNull(stringAt(tracker, "review_state"))
    },
    github: {
      enabled: booleanAt(github, "enabled", false),
      owner: emptyToNull(stringAt(github, "owner")),
      repo: emptyToNull(stringAt(github, "repo")),
      api_endpoint: stringAt(github, "api_endpoint") ?? "https://api.github.com",
      token: resolveOptionalSecret(stringAt(github, "token"), env),
      remote: stringAt(github, "remote") ?? "origin",
      base_branch: stringAt(github, "base_branch") ?? "main",
      branch_prefix: stringAt(github, "branch_prefix") ?? "symphony",
      pr_ready_file: stringAt(github, "pr_ready_file") ?? "SYMPHONY_PR_READY.json",
      evidence_file: stringAt(github, "evidence_file") ?? "SYMPHONY_EVIDENCE.json",
      draft: booleanAt(github, "draft", false),
      merge: {
        enabled: booleanAt(githubMerge, "enabled", false),
        method: mergeMethodAt(githubMerge, "method", "squash"),
        require_approval: booleanAt(githubMerge, "require_approval", true),
        require_successful_checks: booleanAt(githubMerge, "require_successful_checks", true),
        require_clean_merge: booleanAt(githubMerge, "require_clean_merge", true),
        delete_branch: booleanAt(githubMerge, "delete_branch", true),
        complete_state: emptyToNull(stringAt(githubMerge, "complete_state"))
      }
    },
    polling: {
      interval_ms: positiveIntegerAt(polling, "interval_ms", 30000)
    },
    workspace: {
      root: resolvePath(stringAt(workspace, "root") ?? path.join(os.tmpdir(), "symphony_workspaces"), workflowDir, env)
    },
    runtime: runtimeConfigAt(runtime, dockerRuntime, workflowDir, env),
    hooks: {
      after_create: emptyToNull(stringAt(hooks, "after_create")),
      before_run: emptyToNull(stringAt(hooks, "before_run")),
      after_run: emptyToNull(stringAt(hooks, "after_run")),
      before_remove: emptyToNull(stringAt(hooks, "before_remove")),
      timeout_ms: positiveIntegerAt(hooks, "timeout_ms", 60000)
    },
    agent: {
      max_concurrent_agents: positiveIntegerAt(agent, "max_concurrent_agents", 10),
      max_turns: positiveIntegerAt(agent, "max_turns", 20),
      max_retry_backoff_ms: positiveIntegerAt(agent, "max_retry_backoff_ms", 300000),
      max_concurrent_agents_by_state: concurrencyMapAt(agent, "max_concurrent_agents_by_state")
    },
    codex: {
      command: stringAt(codex, "command") ?? "codex app-server",
      approval_policy: valueAt(codex, "approval_policy") ?? null,
      thread_sandbox: valueAt(codex, "thread_sandbox") ?? null,
      turn_sandbox_policy: valueAt(codex, "turn_sandbox_policy") ?? null,
      turn_timeout_ms: positiveIntegerAt(codex, "turn_timeout_ms", 3600000),
      read_timeout_ms: positiveIntegerAt(codex, "read_timeout_ms", 5000),
      stall_timeout_ms: integerAt(codex, "stall_timeout_ms", 300000),
      linear_graphql_mcp: {
        enabled: booleanAt(linearGraphqlMcp, "enabled", true),
        server_name: mcpServerNameAt(linearGraphqlMcp, "server_name", "symphony_linear")
      }
    },
    observability: {
      recent_event_limit: positiveIntegerAt(observability, "recent_event_limit", 200),
      issue_event_limit: positiveIntegerAt(observability, "issue_event_limit", 50),
      run_attempt_limit: positiveIntegerAt(observability, "run_attempt_limit", 50)
    },
    server: {
      port: overrides.port ?? optionalIntegerAt(server, "port"),
      host: stringAt(server, "host") ?? "127.0.0.1"
    }
  };
}

export function validateDispatchConfig(config: SymphonyConfig): void {
  if (config.tracker.kind !== "linear") {
    throw new SymphonyError("unsupported_tracker_kind", `Unsupported tracker kind: ${String(config.tracker.kind)}`);
  }
  if (!config.tracker.api_key) {
    throw new SymphonyError("missing_tracker_api_key", "Tracker API key is missing");
  }
  if (!config.tracker.project_slug) {
    throw new SymphonyError("missing_tracker_project_slug", "Linear project_slug is required");
  }
  if (!config.codex.command.trim()) {
    throw new SymphonyError("missing_codex_command", "codex.command must be present");
  }
  if (config.tracker.claim_state && !stateList(config.tracker.active_states).has(normalizeState(config.tracker.claim_state))) {
    throw new SymphonyError("invalid_config_value", "tracker.claim_state must also be listed in tracker.active_states");
  }
  if (config.runtime.kind === "docker" && !config.runtime.docker.image.trim()) {
    throw new SymphonyError("missing_runtime_image", "runtime.docker.image must be present when runtime.kind is docker");
  }
  if (config.github.enabled) {
    if (!config.github.owner) throw new SymphonyError("missing_github_owner", "github.owner is required when github.enabled is true");
    if (!config.github.repo) throw new SymphonyError("missing_github_repo", "github.repo is required when github.enabled is true");
    if (!config.github.token) throw new SymphonyError("missing_github_token", "github.token is required when github.enabled is true");
    if (!config.github.remote.trim()) throw new SymphonyError("invalid_config_value", "github.remote must be non-empty");
    if (!config.github.base_branch.trim()) throw new SymphonyError("invalid_config_value", "github.base_branch must be non-empty");
    if (!config.github.pr_ready_file.trim() || config.github.pr_ready_file.includes("/") || config.github.pr_ready_file.includes("\\")) {
      throw new SymphonyError("invalid_config_value", "github.pr_ready_file must be a workspace-root file name");
    }
    if (!config.github.evidence_file.trim() || config.github.evidence_file.includes("/") || config.github.evidence_file.includes("\\")) {
      throw new SymphonyError("invalid_config_value", "github.evidence_file must be a workspace-root file name");
    }
  }
}

export function normalizeState(state: string): string {
  return state.toLowerCase();
}

export function isActiveState(state: string, config: SymphonyConfig): boolean {
  return stateList(config.tracker.active_states).has(normalizeState(state));
}

export function isTerminalState(state: string, config: SymphonyConfig): boolean {
  return stateList(config.tracker.terminal_states).has(normalizeState(state));
}

function stateList(states: string[]): Set<string> {
  return new Set(states.map(normalizeState));
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function valueAt(root: Record<string, unknown>, key: string): unknown {
  return root[key];
}

function stringAt(root: Record<string, unknown>, key: string): string | null {
  const value = root[key];
  return typeof value === "string" ? value : null;
}

function booleanAt(root: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = root[key];
  return typeof value === "boolean" ? value : fallback;
}

function mergeMethodAt(root: Record<string, unknown>, key: string, fallback: "merge" | "squash" | "rebase"): "merge" | "squash" | "rebase" {
  const value = stringAt(root, key);
  if (!value) return fallback;
  if (value === "merge" || value === "squash" || value === "rebase") return value;
  throw new SymphonyError("invalid_config_value", `${key} must be merge, squash, or rebase`);
}

function mcpServerNameAt(root: Record<string, unknown>, key: string, fallback: string): string {
  const value = stringAt(root, key) ?? fallback;
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new SymphonyError("invalid_config_value", `${key} must contain only letters, numbers, and underscores`);
  }
  return value;
}

function stringListAt(root: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = root[key];
  if (!Array.isArray(value)) return [...fallback];
  const values = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return values.length > 0 ? values : [...fallback];
}

function integerAt(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];
  return Number.isInteger(value) ? Number(value) : fallback;
}

function optionalIntegerAt(root: Record<string, unknown>, key: string): number | null {
  const value = root[key];
  return Number.isInteger(value) ? Number(value) : null;
}

function positiveIntegerAt(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  if (value === undefined) return fallback;
  throw new SymphonyError("invalid_config_value", `${key} must be a positive integer`);
}

function concurrencyMapAt(root: Record<string, unknown>, key: string): Record<string, number> {
  const value = root[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [state, limit] of Object.entries(value)) {
    if (Number.isInteger(limit) && Number(limit) > 0) out[normalizeState(state)] = Number(limit);
  }
  return out;
}

function runtimeConfigAt(
  runtime: Record<string, unknown>,
  docker: Record<string, unknown>,
  workflowDir: string,
  env: ConfigEnvironment
): SymphonyConfig["runtime"] {
  const kind = stringAt(runtime, "kind") ?? "docker";
  if (kind === "host") return { kind: "host" };
  if (kind !== "docker") throw new SymphonyError("invalid_config_value", "runtime.kind must be host or docker");
  return {
    kind: "docker",
    docker: {
      image: stringAt(docker, "image") ?? "symphony-codex-worker:latest",
      workspace_mount: absoluteContainerPathAt(docker, "workspace_mount", "/workspace"),
      codex_home: optionalResolvedPathAt(docker, "codex_home", path.join(os.homedir(), ".codex"), workflowDir, env),
      codex_home_mount: absoluteContainerPathAt(docker, "codex_home_mount", "/root/.codex"),
      mcp_host: stringAt(docker, "mcp_host") ?? "host.docker.internal",
      mcp_bind_host: stringAt(docker, "mcp_bind_host") ?? "0.0.0.0",
      add_host_gateway: booleanAt(docker, "add_host_gateway", true),
      network: emptyToNull(stringAt(docker, "network")),
      memory: emptyToNull(stringAt(docker, "memory")),
      cpus: emptyToNull(stringAt(docker, "cpus")),
      extra_args: stringListAt(docker, "extra_args", []),
      environment: stringMapAt(docker, "environment")
    }
  };
}

function absoluteContainerPathAt(root: Record<string, unknown>, key: string, fallback: string): string {
  const value = stringAt(root, key) ?? fallback;
  if (!value.startsWith("/")) throw new SymphonyError("invalid_config_value", `${key} must be an absolute container path`);
  return value;
}

function optionalResolvedPathAt(
  root: Record<string, unknown>,
  key: string,
  fallback: string | null,
  workflowDir: string,
  env: ConfigEnvironment
): string | null {
  const value = root[key];
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return resolvePath(trimmed, workflowDir, env);
  }
  return fallback ? resolvePath(fallback, workflowDir, env) : null;
}

function stringMapAt(root: Record<string, unknown>, key: string): Record<string, string> {
  const value = root[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") out[entryKey] = entryValue;
  }
  return out;
}

function resolveSecret(value: string, env: ConfigEnvironment): string | null {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return emptyToNull(env[value.slice(1)] ?? "");
  return emptyToNull(value);
}

function resolveOptionalSecret(value: string | null, env: ConfigEnvironment): string | null {
  if (value === null) return null;
  return resolveSecret(value, env);
}

function resolvePath(value: string, workflowDir: string, env: ConfigEnvironment): string {
  let expanded = value;
  if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(expanded)) expanded = env[expanded.slice(1)] ?? "";
  if (!expanded) throw new SymphonyError("invalid_config_value", "workspace.root resolved to an empty path");
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workflowDir, expanded));
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

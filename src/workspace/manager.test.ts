import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { WorkspaceManager } from "./manager.js";

const execFileAsync = promisify(execFile);

function config(root: string, hooks: Partial<SymphonyConfig["hooks"]> = {}): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "secret",
      project_slug: "demo",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 1000 },
    workspace: { root },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000, ...hooks },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 1000,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
    server: { port: null, host: "127.0.0.1" }
  };
}

function githubDisabled(): SymphonyConfig["github"] {
  return {
    enabled: false,
    owner: null,
    repo: null,
    api_endpoint: "https://api.github.com",
    token: null,
    remote: "origin",
    base_branch: "main",
    branch_prefix: "symphony",
    pr_ready_file: "SYMPHONY_PR_READY.json",
    evidence_file: "SYMPHONY_EVIDENCE.json",
    draft: false,
    merge: githubMergeDisabled()
  };
}

function githubMergeDisabled(): SymphonyConfig["github"]["merge"] {
  return {
    enabled: false,
    method: "squash",
    require_approval: true,
    require_successful_checks: true,
    require_clean_merge: true,
    delete_branch: true,
    complete_state: null
  };
}

describe("workspace manager", () => {
  test("creates deterministic sanitized workspace path and reuses it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-"));
    const manager = new WorkspaceManager(() => config(root), createLogger(() => undefined));
    const first = await manager.createForIssue("ABC/1 unsafe");
    const second = await manager.createForIssue("ABC/1 unsafe");
    expect(first.workspace_key).toBe("ABC_1_unsafe");
    expect(first.created_now).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.created_now).toBe(false);
  });

  test("runs hooks with required failure semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-"));
    const manager = new WorkspaceManager(
      () =>
        config(root, {
          after_create: "printf created > hook.txt",
          before_run: "printf before >> hook.txt",
          after_run: "printf after >> hook.txt",
          before_remove: "exit 7"
        }),
      createLogger(() => undefined)
    );
    const workspace = await manager.createForIssue("ABC-1");
    expect(await readFile(path.join(workspace.path, "hook.txt"), "utf8")).toBe("created");
    await manager.runBeforeRun(workspace.path);
    await manager.runAfterRun(workspace.path);
    expect(await readFile(path.join(workspace.path, "hook.txt"), "utf8")).toBe("createdbeforeafter");
    await expect(manager.removeForIssue("ABC-1")).resolves.toBeUndefined();
  });

  test("fatal hooks abort and containment is enforced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-"));
    const manager = new WorkspaceManager(() => config(root, { after_create: "exit 9" }), createLogger(() => undefined));
    await expect(manager.createForIssue("ABC-1")).rejects.toMatchObject({ code: "hook_error" });
    await writeFile(path.join(root, "ABC-2"), "file");
    await expect(manager.createForIssue("ABC-2")).rejects.toMatchObject({ code: "workspace_path_not_directory" });
    expect(() => manager.validateAgentCwd(path.dirname(root))).toThrow(/workspace root/);
  });

  test("before_run hook can fast-forward a reused git workspace", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-git-"));
    const source = path.join(temp, "source");
    const root = path.join(temp, "workspaces");
    await mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Symphony Test");
    await git(source, "config", "user.email", "symphony-test@example.invalid");
    await writeFile(path.join(source, "README.md"), "one\n");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "initial");

    const manager = new WorkspaceManager(
      () =>
        config(root, {
          after_create: `git clone ${source} .`,
          before_run: "git fetch origin main && git merge --ff-only origin/main"
        }),
      createLogger(() => undefined)
    );
    const workspace = await manager.createForIssue("ABC-1");
    const firstHead = await gitOut(workspace.path, "rev-parse", "HEAD");

    await writeFile(path.join(source, "README.md"), "two\n");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "second");
    const secondHead = await gitOut(source, "rev-parse", "HEAD");

    await manager.runBeforeRun(workspace.path);
    expect(await gitOut(workspace.path, "rev-parse", "HEAD")).toBe(secondHead);
    expect(firstHead).not.toBe(secondHead);
  });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

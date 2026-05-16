import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { issue } from "../testing/fakes.js";
import { GitHubPullRequestPublisher } from "./publisher.js";

const execFileAsync = promisify(execFile);

describe("GitHub PR publisher", () => {
  test("pushes a committed worker branch and creates a pull request", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-gh-"));
    const remote = path.join(temp, "remote.git");
    const seed = path.join(temp, "seed");
    const workspace = path.join(temp, "workspace");
    await git(temp, "init", "--bare", remote);
    await mkdir(seed);
    await git(seed, "init", "--initial-branch=main");
    await git(seed, "config", "user.name", "Symphony Test");
    await git(seed, "config", "user.email", "symphony-test@example.invalid");
    await writeFile(path.join(seed, "README.md"), "base\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "base");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "origin", "main");
    await git(temp, "clone", remote, workspace);
    await git(workspace, "checkout", "main");
    await git(workspace, "config", "user.name", "Symphony Worker");
    await git(workspace, "config", "user.email", "symphony-worker@example.invalid");
    await writeFile(path.join(workspace, "feature.txt"), "done\n");
    await git(workspace, "add", "feature.txt");
    await git(workspace, "commit", "-m", "Add feature");
    await mkdir(path.join(workspace, "artifacts", "SAM-123"), { recursive: true });
    await writeFile(path.join(workspace, "artifacts", "SAM-123", "home.png"), "fake screenshot\n");
    await writeFile(path.join(workspace, "SYMPHONY_PR_READY.json"), "{}\n");
    await writeFile(path.join(workspace, "SYMPHONY_EVIDENCE.json"), "{}\n");

    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.method ?? "GET") === "GET") {
        return jsonResponse([]);
      }
      return jsonResponse({ number: 42, html_url: "https://github.test/acme/widgets/pull/42" });
    };

    const cfg = config(temp, remote);
    const publisher = new GitHubPullRequestPublisher(() => cfg, createLogger(() => undefined), fetchImpl);
    const published = await publisher.publish({
      issue: issue({ identifier: "SAM-123", title: "Add publish loop", url: "https://linear.test/SAM-123" }),
      workspacePath: workspace,
      manifest: { summary: "Implemented the publishing path.", verification: ["pnpm test"], risk: "Low" },
      evidenceManifest: { artifacts: [{ path: "artifacts/SAM-123/home.png", kind: "screenshot" }] }
    });

    expect(published).toMatchObject({
      number: 42,
      url: "https://github.test/acme/widgets/pull/42",
      branch: "symphony/sam-123-add-publish-loop",
      created: true
    });
    expect(await gitOut(workspace, "rev-parse", "--abbrev-ref", "HEAD")).toBe("symphony/sam-123-add-publish-loop");
    expect(await gitOut(seed, "ls-remote", "--heads", remote, "symphony/sam-123-add-publish-loop")).toContain("refs/heads/symphony/sam-123-add-publish-loop");
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.body).toMatchObject({
      title: "SAM-123: Add publish loop",
      head: "symphony/sam-123-add-publish-loop",
      base: "main",
      draft: false
    });
  });

  test("updates an existing pull request branch with force-with-lease after rebase", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-gh-update-"));
    const remote = path.join(temp, "remote.git");
    const seed = path.join(temp, "seed");
    const workspace = path.join(temp, "workspace");
    const branch = "symphony/sam-123-add-publish-loop";
    await git(temp, "init", "--bare", remote);
    await mkdir(seed);
    await git(seed, "init", "--initial-branch=main");
    await git(seed, "config", "user.name", "Symphony Test");
    await git(seed, "config", "user.email", "symphony-test@example.invalid");
    await writeFile(path.join(seed, "README.md"), "base\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "base");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "origin", "main");

    await git(seed, "checkout", "-b", branch);
    await writeFile(path.join(seed, "feature.txt"), "original worker change\n");
    await git(seed, "add", "feature.txt");
    await git(seed, "commit", "-m", "Add original worker change");
    const oldRemoteSha = await gitOut(seed, "rev-parse", "HEAD");
    await git(seed, "push", "origin", `HEAD:refs/heads/${branch}`);

    await git(seed, "checkout", "main");
    await writeFile(path.join(seed, "main.txt"), "main advanced\n");
    await git(seed, "add", "main.txt");
    await git(seed, "commit", "-m", "Advance main");
    await git(seed, "push", "origin", "main");

    await git(temp, "clone", remote, workspace);
    await git(workspace, "checkout", branch);
    await git(workspace, "config", "user.name", "Symphony Worker");
    await git(workspace, "config", "user.email", "symphony-worker@example.invalid");
    await git(workspace, "fetch", "origin", "main");
    await git(workspace, "rebase", "origin/main");
    await writeFile(path.join(workspace, "followup.txt"), "review feedback addressed\n");
    await git(workspace, "add", "followup.txt");
    await git(workspace, "commit", "-m", "Address review feedback");
    await writeFile(path.join(workspace, "SYMPHONY_PR_READY.json"), "{}\n");
    const workspaceHead = await gitOut(workspace, "rev-parse", "HEAD");

    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.method ?? "GET") === "GET") {
        return jsonResponse([{ number: 42, html_url: "https://github.test/acme/widgets/pull/42", head: { sha: oldRemoteSha } }]);
      }
      return jsonResponse({ number: 42, html_url: "https://github.test/acme/widgets/pull/42", head: { sha: workspaceHead } });
    };

    const cfg = config(temp, remote);
    const publisher = new GitHubPullRequestPublisher(() => cfg, createLogger(() => undefined), fetchImpl);
    const published = await publisher.publish({
      issue: issue({ identifier: "SAM-123", title: "Add publish loop", url: "https://linear.test/SAM-123" }),
      workspacePath: workspace,
      manifest: { summary: "Addressed review feedback.", verification: ["pnpm test"], risk: "Low" }
    });

    expect(published).toMatchObject({ number: 42, created: false, branch });
    expect(await gitOut(seed, "ls-remote", remote, branch)).toContain(workspaceHead);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    expect(requests[1]?.body).toMatchObject({ title: "SAM-123: Add publish loop" });
  });
});

function config(root: string, remote: string): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "linear-secret",
      project_slug: "demo",
      active_states: ["Ready", "In Progress"],
      terminal_states: ["Done"],
      claim_state: "In Progress",
      review_state: "Needs Human"
    },
    github: {
      enabled: true,
      owner: "acme",
      repo: "widgets",
      api_endpoint: "https://api.github.test",
      token: "github-secret-token",
      remote,
      base_branch: "main",
      branch_prefix: "symphony",
      pr_ready_file: "SYMPHONY_PR_READY.json",
      evidence_file: "SYMPHONY_EVIDENCE.json",
      draft: false,
      merge: {
        enabled: false,
        method: "squash",
        require_approval: true,
        require_successful_checks: true,
        require_clean_merge: true,
        delete_branch: true,
        complete_state: null
      }
    },
    polling: { interval_ms: 1000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

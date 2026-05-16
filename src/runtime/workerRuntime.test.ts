import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig, Workspace } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { issue } from "../testing/fakes.js";
import { createWorkerRuntime } from "./workerRuntime.js";

describe("worker runtime", () => {
  test("docker runtime exposes container workspace, authenticated MCP routing, and scoped env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runtime-"));
    const workspace = await workspaceAt(root, "SAM-71");
    const runtime = createWorkerRuntime(config(root, fakeDockerImage(), null), workspace, issue({ identifier: "SAM-71" }), createLogger(() => undefined));

    expect(runtime.kind).toBe("docker");
    expect(runtime.hostWorkspacePath).toBe(workspace.path);
    expect(runtime.runtimeWorkspacePath).toBe("/workspace");
    expect(runtime.bridgeBindHost).toBe("0.0.0.0");
    expect(runtime.bridgePublicHost).toBe("host.docker.internal");
    expect(runtime.bridgeBearerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(runtime.env).toMatchObject({
      SYMPHONY_ISSUE_IDENTIFIER: "SAM-71",
      SYMPHONY_RUNTIME_WORKSPACE: "/workspace",
      PORT: runtime.env.SYMPHONY_PORT_BASE,
      HOME: "/root",
      CODEX_HOME: "/root/.codex",
      COMPOSE_PROJECT_NAME: "symphony_sam-71"
    });
  });

  test("docker app-server launch keeps bearer token out of argv and passes it only by env name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runtime-"));
    const fakeBin = path.join(root, "bin");
    const logPath = path.join(root, "docker.log");
    const codexHome = path.join(root, "host-codex-home");
    await mkdir(path.join(codexHome, "plugins", "cache", "linear"), { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "{}");
    await writeFile(path.join(codexHome, "config.toml"), "[plugins.\"linear@openai-curated\"]\nenabled = true\n");
    await writeFile(path.join(codexHome, "plugins", "cache", "linear", "SKILL.md"), "ambient linear skill");
    await writeFakeDocker(fakeBin, logPath);
    const workspace = await workspaceAt(root, "SAM-72");
    const runtime = createWorkerRuntime(config(root, fakeDockerImage(), codexHome), workspace, issue({ identifier: "SAM-72" }), createLogger(() => undefined));

    const child = runtime.spawnAppServer("codex app-server", {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      SYMPHONY_LINEAR_MCP_TOKEN: "secret-bridge-token"
    });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", () => resolve());
      child.on("error", reject);
    });

    const entry = JSON.parse(await readFile(logPath, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };
    expect(entry.argv).toContain("--env");
    expect(entry.argv).toContain("SYMPHONY_LINEAR_MCP_TOKEN");
    expect(entry.argv.join("\n")).not.toContain("secret-bridge-token");
    expect(entry.argv.join("\n")).not.toContain(`source=${codexHome},target=/root/.codex`);
    expect(entry.argv.join("\n")).toContain("type=bind,source=");
    expect(entry.argv.join("\n")).toContain("target=/workspace");
    const codexMountSource = entry.argv
      .find((arg) => arg.includes("target=/root/.codex"))
      ?.match(/source=([^,]+),target=\/root\/.codex/)?.[1];
    expect(codexMountSource).toBeTruthy();
    expect(await readFile(path.join(String(codexMountSource), "auth.json"), "utf8")).toBe("{}");
    await expect(readFile(path.join(String(codexMountSource), "config.toml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(String(codexMountSource), "plugins", "cache", "linear", "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(entry.argv).toContain("host.docker.internal:host-gateway");
    expect(entry.argv).toContain(fakeDockerImage());
    expect(entry.env.SYMPHONY_LINEAR_MCP_TOKEN).toBe("secret-bridge-token");
    await runtime.cleanup();
  });
});

async function workspaceAt(root: string, key: string): Promise<Workspace> {
  const workspacePath = path.join(root, "workspaces", key);
  await mkdir(workspacePath, { recursive: true });
  return { path: workspacePath, workspace_key: key, created_now: true };
}

function fakeDockerImage(): string {
  return "symphony-codex-worker:test";
}

async function writeFakeDocker(binDir: string, logPath: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const dockerPath = path.join(binDir, "docker");
  await writeFile(
    dockerPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), env: { SYMPHONY_LINEAR_MCP_TOKEN: process.env.SYMPHONY_LINEAR_MCP_TOKEN } }));`,
      "process.exit(0);",
      ""
    ].join("\n")
  );
  await chmod(dockerPath, 0o755);
}

function config(root: string, image: string, codexHome: string | null): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "secret",
      project_slug: "demo",
      active_states: ["Todo"],
      terminal_states: ["Done"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 1000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: {
      kind: "docker",
      docker: {
        image,
        workspace_mount: "/workspace",
        codex_home: codexHome,
        codex_home_mount: "/root/.codex",
        mcp_host: "host.docker.internal",
        mcp_bind_host: "0.0.0.0",
        add_host_gateway: true,
        network: null,
        memory: "4g",
        cpus: "2",
        extra_args: ["--pull", "never"],
        environment: { EXTRA_FLAG: "1" }
      }
    },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Issue, SymphonyConfig, Workspace } from "../domain.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";

export type WorkerRuntimeLease = {
  kind: "host" | "docker";
  hostWorkspacePath: string;
  runtimeWorkspacePath: string;
  bridgeBindHost: string;
  bridgePublicHost: string;
  bridgeBearerToken: string | null;
  env: NodeJS.ProcessEnv;
  spawnAppServer(command: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  runHook(name: "before_run" | "after_run", script: string | null, timeoutMs: number): Promise<void>;
  cleanup(): Promise<void>;
};

export function createWorkerRuntime(config: SymphonyConfig, workspace: Workspace, issue: Issue, logger: Logger): WorkerRuntimeLease {
  if (config.runtime.kind === "host") return createHostRuntime(workspace, issue, logger);
  return createDockerRuntime(config, workspace, issue, logger);
}

function createHostRuntime(workspace: Workspace, issue: Issue, logger: Logger): WorkerRuntimeLease {
  const env = runtimeEnv(issue, workspace.workspace_key, workspace.path, workspace.path, 31000 + stableIssueOffset(workspace.workspace_key));
  return {
    kind: "host",
    hostWorkspacePath: workspace.path,
    runtimeWorkspacePath: workspace.path,
    bridgeBindHost: "127.0.0.1",
    bridgePublicHost: "127.0.0.1",
    bridgeBearerToken: null,
    env,
    spawnAppServer(command, childEnv) {
      logger.info("worker runtime launching app-server", { issue_identifier: issue.identifier, runtime: "host", workspace_path: workspace.path });
      return spawn("bash", ["-lc", command], {
        cwd: workspace.path,
        env: { ...childEnv, ...env },
        stdio: ["pipe", "pipe", "pipe"]
      });
    },
    async runHook(name, script, timeoutMs) {
      if (!script) return;
      logger.info("worker runtime hook started", { hook: name, runtime: "host", workspace_path: workspace.path });
      await runProcess(
        "sh",
        ["-lc", script],
        { cwd: workspace.path, env: { ...process.env, ...env } },
        timeoutMs,
        `Runtime hook ${name}`
      );
      logger.info("worker runtime hook completed", { hook: name, runtime: "host", workspace_path: workspace.path });
    },
    async cleanup() {
      return;
    }
  };
}

function createDockerRuntime(config: SymphonyConfig, workspace: Workspace, issue: Issue, logger: Logger): WorkerRuntimeLease {
  const docker = config.runtime.kind === "docker" ? config.runtime.docker : null;
  if (!docker) throw new SymphonyError("invalid_config_value", "Docker runtime configuration is missing");
  const runKey = dockerName(`symphony-${workspace.workspace_key}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
  const runtimeRoot = path.join(os.tmpdir(), "symphony_runtime", runKey);
  const mountedCodexHome = prepareEphemeralCodexHome(docker.codex_home, runtimeRoot);
  const portBase = 42000 + stableIssueOffset(workspace.workspace_key);
  const env = {
    ...runtimeEnv(issue, workspace.workspace_key, workspace.path, docker.workspace_mount, portBase),
    HOME: path.posix.dirname(docker.codex_home_mount),
    CODEX_HOME: docker.codex_home_mount,
    TMPDIR: "/tmp/symphony",
    COMPOSE_PROJECT_NAME: dockerName(`symphony_${workspace.workspace_key}`),
    ...docker.environment
  };
  const bridgeBearerToken = randomBytes(32).toString("base64url");
  let appContainerName: string | null = null;

  return {
    kind: "docker",
    hostWorkspacePath: workspace.path,
    runtimeWorkspacePath: docker.workspace_mount,
    bridgeBindHost: docker.mcp_bind_host,
    bridgePublicHost: docker.mcp_host,
    bridgeBearerToken,
    env,
    spawnAppServer(command, childEnv) {
      appContainerName = dockerName(`${runKey}-app`);
      const containerEnv = { ...childEnv, ...env };
      const args = dockerRunArgs(
        config,
        workspace.path,
        appContainerName,
        mountedCodexHome,
        containerEnv,
        `mkdir -p "$TMPDIR" && cd ${shellQuote(docker.workspace_mount)} && exec ${command}`
      );
      logger.info("worker runtime launching app-server", {
        issue_identifier: issue.identifier,
        runtime: "docker",
        image: docker.image,
        container: appContainerName,
        workspace_path: workspace.path,
        runtime_workspace_path: docker.workspace_mount
      });
      return spawn("docker", args, {
        cwd: workspace.path,
        env: dockerCliEnv(containerEnv),
        stdio: ["pipe", "pipe", "pipe"]
      });
    },
    async runHook(name, script, timeoutMs) {
      if (!script) return;
      const hookContainer = dockerName(`${runKey}-${name}`);
      const args = dockerRunArgs(
        config,
        workspace.path,
        hookContainer,
        mountedCodexHome,
        env,
        `mkdir -p "$TMPDIR" && cd ${shellQuote(docker.workspace_mount)} && ${script}`
      );
      logger.info("worker runtime hook started", {
        hook: name,
        runtime: "docker",
        image: docker.image,
        container: hookContainer,
        workspace_path: workspace.path
      });
      try {
        await runProcess("docker", args, { cwd: workspace.path, env: dockerCliEnv(env) }, timeoutMs, `Runtime hook ${name}`);
        logger.info("worker runtime hook completed", { hook: name, runtime: "docker", container: hookContainer, workspace_path: workspace.path });
      } catch (error) {
        await forceRemoveContainer(hookContainer).catch(() => undefined);
        throw error;
      }
    },
    async cleanup() {
      if (appContainerName) await forceRemoveContainer(appContainerName).catch(() => undefined);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  };
}

function dockerRunArgs(
  config: SymphonyConfig,
  workspacePath: string,
  containerName: string,
  mountedCodexHome: string | null,
  containerEnv: NodeJS.ProcessEnv,
  shellScript: string
): string[] {
  if (config.runtime.kind !== "docker") throw new SymphonyError("invalid_config_value", "Docker runtime configuration is missing");
  const docker = config.runtime.docker;
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--workdir",
    docker.workspace_mount,
    "--mount",
    `type=bind,source=${workspacePath},target=${docker.workspace_mount}`
  ];
  if (mountedCodexHome) {
    args.push("--mount", `type=bind,source=${mountedCodexHome},target=${docker.codex_home_mount}`);
  }
  if (docker.add_host_gateway) args.push("--add-host", "host.docker.internal:host-gateway");
  if (docker.network) args.push("--network", docker.network);
  if (docker.memory) args.push("--memory", docker.memory);
  if (docker.cpus) args.push("--cpus", docker.cpus);
  args.push(...docker.extra_args);
  args.push("--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  for (const key of Object.keys(containerEnv).filter((key) => key !== "PATH" && isValidEnvKey(key)).sort()) args.push("--env", key);
  args.push(docker.image, "bash", "-lc", shellScript);
  return args;
}

function runtimeEnv(issue: Issue, workspaceKey: string, hostWorkspacePath: string, runtimeWorkspacePath: string, portBase: number): NodeJS.ProcessEnv {
  return {
    SYMPHONY_RUN_ID: `${workspaceKey}-${Date.now().toString(36)}`,
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_WORKSPACE_KEY: workspaceKey,
    SYMPHONY_HOST_WORKSPACE: hostWorkspacePath,
    SYMPHONY_RUNTIME_WORKSPACE: runtimeWorkspacePath,
    SYMPHONY_PORT_BASE: String(portBase),
    PORT: String(portBase),
    APP_PORT: String(portBase),
    VITE_PORT: String(portBase + 1),
    DATABASE_PORT: String(portBase + 10),
    REDIS_PORT: String(portBase + 11)
  };
}

function prepareEphemeralCodexHome(source: string | null, runtimeRoot: string): string | null {
  if (!source) return null;
  const target = path.join(runtimeRoot, "codex-home");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyCodexHomeFile(source, target, "auth.json");
  return target;
}

function copyCodexHomeFile(source: string, target: string, relativePath: string): void {
  const from = path.join(source, relativePath);
  if (!existsSync(from)) return;
  const to = path.join(target, relativePath);
  mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
}

function stableIssueOffset(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 7000;
  return hash;
}

function dockerCliEnv(containerEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...containerEnv
  };
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  timeoutMs: number,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new SymphonyError("hook_timeout", `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) output = output.slice(-4096);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new SymphonyError("hook_error", `${label} exited code=${code ?? "null"} signal=${signal ?? "null"} output=${output}`));
    });
  });
}

function forceRemoveContainer(containerName: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore", env: process.env });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function dockerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_")
    .replace(/^[^a-z0-9]+/, "s")
    .slice(0, 63);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

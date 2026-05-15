import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { SymphonyConfig, Workspace } from "../domain.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";

export class WorkspaceManager {
  constructor(
    private getConfig: () => SymphonyConfig,
    private readonly logger: Logger
  ) {}

  sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  }

  workspacePath(identifier: string): string {
    const root = path.resolve(this.getConfig().workspace.root);
    const workspacePath = path.resolve(root, this.sanitizeIdentifier(identifier));
    assertContained(root, workspacePath);
    return workspacePath;
  }

  async createForIssue(identifier: string): Promise<Workspace> {
    const workspacePath = this.workspacePath(identifier);
    const root = path.resolve(this.getConfig().workspace.root);
    await mkdir(root, { recursive: true });

    let createdNow = false;
    try {
      const info = await stat(workspacePath);
      if (!info.isDirectory()) {
        throw new SymphonyError("workspace_path_not_directory", `Workspace path exists but is not a directory: ${workspacePath}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        await mkdir(workspacePath, { recursive: false });
        createdNow = true;
      } else {
        throw error;
      }
    }

    const workspace = {
      path: workspacePath,
      workspace_key: path.basename(workspacePath),
      created_now: createdNow
    };

    const afterCreate = this.getConfig().hooks.after_create;
    if (createdNow && afterCreate) {
      await this.runHook("after_create", workspacePath, afterCreate, true);
    }

    return workspace;
  }

  async runBeforeRun(workspacePath: string): Promise<void> {
    const hook = this.getConfig().hooks.before_run;
    if (hook) await this.runHook("before_run", workspacePath, hook, true);
  }

  async runAfterRun(workspacePath: string): Promise<void> {
    const hook = this.getConfig().hooks.after_run;
    if (hook) await this.runHook("after_run", workspacePath, hook, false);
  }

  async removeForIssue(identifier: string): Promise<void> {
    const workspacePath = this.workspacePath(identifier);
    const hook = this.getConfig().hooks.before_remove;
    if (hook) await this.runHook("before_remove", workspacePath, hook, false);
    await rm(workspacePath, { recursive: true, force: true });
    this.logger.info("workspace cleanup completed", { issue_identifier: identifier, workspace_path: workspacePath });
  }

  validateAgentCwd(workspacePath: string): void {
    const root = path.resolve(this.getConfig().workspace.root);
    const resolved = path.resolve(workspacePath);
    assertContained(root, resolved);
    if (resolved !== workspacePath) {
      throw new SymphonyError("invalid_workspace_cwd", "Agent cwd must be the normalized per-issue workspace path");
    }
  }

  private async runHook(name: string, workspacePath: string, script: string, fatal: boolean): Promise<void> {
    this.validateAgentCwd(workspacePath);
    this.logger.info("workspace hook started", { hook: name, workspace_path: workspacePath });
    try {
      await runShellScript(script, workspacePath, this.getConfig().hooks.timeout_ms);
      this.logger.info("workspace hook completed", { hook: name, workspace_path: workspacePath });
    } catch (error) {
      this.logger.warn("workspace hook failed", { hook: name, workspace_path: workspacePath, error: errorMessage(error) });
      if (fatal) throw new SymphonyError("hook_error", `${name} hook failed`, error);
    }
  }
}

export function assertContained(root: string, child: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new SymphonyError("workspace_path_outside_root", `Workspace path must remain under workspace root`);
}

function runShellScript(script: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new SymphonyError("hook_timeout", `Hook timed out after ${timeoutMs}ms`));
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
      else reject(new SymphonyError("hook_error", `Hook exited code=${code ?? "null"} signal=${signal ?? "null"} output=${output}`));
    });
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

import { access } from "node:fs/promises";
import path from "node:path";
import type {
  Issue,
  RunResult,
  RunFailureReason,
  SymphonyConfig,
  WorkflowDefinition,
  CodexRuntimeEvent,
  TrackerClient,
  GraphqlToolExecutor
} from "../domain.js";
import { errorMessage, SymphonyError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { createWorkerRuntime, type WorkerRuntimeLease } from "../runtime/workerRuntime.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { continuationPrompt, renderIssuePrompt } from "../workflow/prompt.js";
import { isActiveState } from "../config/config.js";
import { CodexAppServerClient } from "./codexClient.js";
import { startLinearGraphqlBridge, type LinearGraphqlBridgeHandle, type LinearGraphqlBridgeStartOptions } from "./linearGraphqlBridge.js";

export type AgentRunnerOptions = {
  issue: Issue;
  attempt: number | null;
  followupContext?: string | null | undefined;
  getConfig: () => SymphonyConfig;
  getWorkflow: () => WorkflowDefinition;
  workspaceManager: WorkspaceManager;
  tracker: TrackerClient;
  logger: Logger;
  onEvent: (event: CodexRuntimeEvent) => void;
  linearTool?: GraphqlToolExecutor | null | undefined;
  linearBridgeFactory?: ((options: LinearGraphqlBridgeStartOptions) => Promise<LinearGraphqlBridgeHandle | null>) | null | undefined;
};

export class AgentRunHandle {
  private client: CodexAppServerClient | null = null;
  private runtime: WorkerRuntimeLease | null = null;
  private cancelReason: string | null = null;
  private cleanupWorkspaceOnCancel = false;

  constructor(private readonly options: AgentRunnerOptions) {}

  async run(): Promise<RunResult> {
    const started = Date.now();
    let workspacePath: string | undefined;
    let bridge: LinearGraphqlBridgeHandle | null = null;
    try {
      if (this.cancelReason) return cancelledRunResult(started, this.cancelReason);
      const workspace = await this.options.workspaceManager.createForIssue(this.options.issue.identifier);
      workspacePath = workspace.path;
      this.options.workspaceManager.validateAgentCwd(workspace.path);
      if (this.cancelReason) {
        if (this.cleanupWorkspaceOnCancel) await this.options.workspaceManager.removeForIssue(this.options.issue.identifier);
        return cancelledRunResult(started, this.cancelReason, workspace.path);
      }
      const config = this.options.getConfig();
      const runtime = createWorkerRuntime(config, workspace, this.options.issue, this.options.logger);
      this.runtime = runtime;
      await runtime.runHook("before_run", config.hooks.before_run, config.hooks.timeout_ms);
      if (config.codex.linear_graphql_mcp.enabled) {
        const bridgeFactory = this.options.linearBridgeFactory ?? startLinearGraphqlBridge;
        bridge = await bridgeFactory({
          executor: this.options.linearTool,
          issue: this.options.issue,
          projectSlug: config.tracker.project_slug,
          bindHost: runtime.bridgeBindHost,
          publicHost: runtime.bridgePublicHost,
          bearerToken: runtime.bridgeBearerToken,
          logger: this.options.logger,
          onEvent: this.options.onEvent
        });
      }
      const client = new CodexAppServerClient({
        config,
        runtime,
        logger: this.options.logger,
        onEvent: this.options.onEvent,
        linearTool: this.options.linearTool,
        issue: this.options.issue,
        linearBridge: bridge
      });
      this.client = client;
      await client.start();
      await client.startThread();

      let turnNumber = 1;
      let issue = this.options.issue;
      for (;;) {
        const prompt =
          turnNumber === 1
            ? await renderIssuePrompt(this.options.getWorkflow(), issue, this.options.attempt, this.options.followupContext ?? null)
            : continuationPrompt(turnNumber, this.options.getConfig().agent.max_turns);
        await client.runTurn(prompt);
        if (await isPrReady(workspace.path, this.options.getConfig())) break;
        const refreshed = await this.options.tracker.fetchIssueStatesByIds([issue.id]);
        issue = refreshed[0] ?? issue;
        if (!isActiveState(issue.state, this.options.getConfig())) break;
        if (turnNumber >= this.options.getConfig().agent.max_turns) break;
        turnNumber += 1;
      }

      await client.stop();
      await bridge?.close();
      bridge = null;
      await runtime.runHook("after_run", config.hooks.after_run, config.hooks.timeout_ms);
      await runtime.cleanup();
      this.runtime = null;
      if (this.cancelReason) {
        return { ok: false, reason: "cancelled", error: this.cancelReason, workspace_path: workspace.path, runtime_seconds: elapsed(started) };
      }
      return { ok: true, reason: "normal", workspace_path: workspace.path, runtime_seconds: elapsed(started) };
    } catch (error) {
      if (this.client) await this.client.stop().catch(() => undefined);
      if (bridge) await bridge.close().catch(() => undefined);
      if (this.runtime) {
        const config = this.options.getConfig();
        await this.runtime.runHook("after_run", config.hooks.after_run, config.hooks.timeout_ms).catch(() => undefined);
        await this.runtime.cleanup().catch(() => undefined);
        this.runtime = null;
      } else if (workspacePath) {
        await this.options.workspaceManager.runAfterRun(workspacePath).catch(() => undefined);
      }
      const reason = classifyRunError(error);
      return {
        ok: false,
        reason,
        error: errorMessage(error),
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
        runtime_seconds: elapsed(started)
      };
    }
  }

  async terminate(reason: string, cleanupWorkspace = false): Promise<void> {
    this.cancelReason = reason;
    this.cleanupWorkspaceOnCancel = this.cleanupWorkspaceOnCancel || cleanupWorkspace;
    await this.client?.stop();
    await this.runtime?.cleanup();
  }
}

function cancelledRunResult(started: number, reason: string, workspacePath?: string): RunResult {
  return {
    ok: false,
    reason: "cancelled",
    error: reason,
    ...(workspacePath ? { workspace_path: workspacePath } : {}),
    runtime_seconds: elapsed(started)
  };
}

async function isPrReady(workspacePath: string, config: SymphonyConfig): Promise<boolean> {
  if (!config.github.enabled) return false;
  try {
    await access(path.join(workspacePath, config.github.pr_ready_file));
    return true;
  } catch {
    return false;
  }
}

function elapsed(started: number): number {
  return (Date.now() - started) / 1000;
}

function classifyRunError(error: unknown): RunFailureReason {
  if (error instanceof SymphonyError) {
    if (error.code === "template_render_error" || error.code === "template_parse_error") return "prompt_error";
    if (error.code === "hook_error" || error.code === "hook_timeout") return "hook_error";
    if (error.code === "turn_timeout") return "turn_timeout";
    if (error.code === "turn_input_required") return "turn_input_required";
    if (error.code === "response_timeout") return "response_timeout";
    if (error.code === "cancelled") return "cancelled";
    if (error.code.startsWith("linear_")) return "tracker_error";
  }
  return "unknown";
}

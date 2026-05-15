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
import { WorkspaceManager } from "../workspace/manager.js";
import { continuationPrompt, renderIssuePrompt } from "../workflow/prompt.js";
import { isActiveState } from "../config/config.js";
import { CodexAppServerClient } from "./codexClient.js";

export type AgentRunnerOptions = {
  issue: Issue;
  attempt: number | null;
  getConfig: () => SymphonyConfig;
  getWorkflow: () => WorkflowDefinition;
  workspaceManager: WorkspaceManager;
  tracker: TrackerClient;
  logger: Logger;
  onEvent: (event: CodexRuntimeEvent) => void;
  linearTool?: GraphqlToolExecutor | null | undefined;
};

export class AgentRunHandle {
  private client: CodexAppServerClient | null = null;
  private cancelReason: string | null = null;

  constructor(private readonly options: AgentRunnerOptions) {}

  async run(): Promise<RunResult> {
    const started = Date.now();
    let workspacePath: string | undefined;
    try {
      const workspace = await this.options.workspaceManager.createForIssue(this.options.issue.identifier);
      workspacePath = workspace.path;
      this.options.workspaceManager.validateAgentCwd(workspace.path);
      await this.options.workspaceManager.runBeforeRun(workspace.path);
      const client = new CodexAppServerClient({
        config: this.options.getConfig(),
        workspacePath: workspace.path,
        logger: this.options.logger,
        onEvent: this.options.onEvent,
        linearTool: this.options.linearTool
      });
      this.client = client;
      await client.start();
      await client.startThread();

      let turnNumber = 1;
      let issue = this.options.issue;
      for (;;) {
        const prompt =
          turnNumber === 1
            ? await renderIssuePrompt(this.options.getWorkflow(), issue, this.options.attempt)
            : continuationPrompt(turnNumber, this.options.getConfig().agent.max_turns);
        await client.runTurn(prompt);
        const refreshed = await this.options.tracker.fetchIssueStatesByIds([issue.id]);
        issue = refreshed[0] ?? issue;
        if (!isActiveState(issue.state, this.options.getConfig())) break;
        if (turnNumber >= this.options.getConfig().agent.max_turns) break;
        turnNumber += 1;
      }

      await client.stop();
      await this.options.workspaceManager.runAfterRun(workspace.path);
      if (this.cancelReason) {
        return { ok: false, reason: "cancelled", error: this.cancelReason, workspace_path: workspace.path, runtime_seconds: elapsed(started) };
      }
      return { ok: true, reason: "normal", workspace_path: workspace.path, runtime_seconds: elapsed(started) };
    } catch (error) {
      if (this.client) await this.client.stop().catch(() => undefined);
      if (workspacePath) await this.options.workspaceManager.runAfterRun(workspacePath).catch(() => undefined);
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

  async terminate(reason: string): Promise<void> {
    this.cancelReason = reason;
    await this.client?.stop();
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

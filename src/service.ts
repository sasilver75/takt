import type { HttpStatusServer } from "./http/server.js";
import { GitHubPullRequestPublisher } from "./github/publisher.js";
import { GitHubPullRequestTracker } from "./github/tracker.js";
import { createHttpStatusServer } from "./http/server.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { JsonDurableStateStore } from "./persistence/jsonStateStore.js";
import { LinearTrackerClient } from "./tracker/linear.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { WorkflowRuntime } from "./workflow/runtime.js";

export type SymphonyServiceOptions = {
  workflowPath?: string | null;
  cwd?: string;
  port?: number | null;
  logger?: Logger;
  env?: Record<string, string | undefined>;
};

export class SymphonyService {
  private workflowRuntime: WorkflowRuntime | null = null;
  private orchestrator: Orchestrator | null = null;
  private httpServer: HttpStatusServer | null = null;
  private readonly logger: Logger;

  constructor(private readonly options: SymphonyServiceOptions = {}) {
    this.logger = options.logger ?? createLogger();
  }

  async start(): Promise<{ http?: { host: string; port: number } }> {
    const workflowPath = selectWorkflowPath(this.options.workflowPath, this.options.cwd);
    const runtime = new WorkflowRuntime({
      workflowPath,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      ...(this.options.port === undefined ? {} : { portOverride: this.options.port }),
      logger: this.logger
    });
    await runtime.start();
    this.workflowRuntime = runtime;
    const tracker = new LinearTrackerClient(() => runtime.getConfig());
    const pullRequestPublisher = new GitHubPullRequestPublisher(() => runtime.getConfig(), this.logger);
    const pullRequestTracker = new GitHubPullRequestTracker(() => runtime.getConfig(), this.logger);
    const durableStore = new JsonDurableStateStore(() => runtime.getConfig(), this.logger);
    const workspaceManager = new WorkspaceManager(() => runtime.getConfig(), this.logger);
    const orchestrator = new Orchestrator({
      getConfig: () => runtime.getConfig(),
      getWorkflow: () => runtime.getWorkflow(),
      validateDispatch: () => runtime.validateDispatch(),
      tracker,
      workspaceManager,
      linearTool: tracker,
      pullRequestPublisher,
      pullRequestTracker,
      durableStore,
      logger: this.logger
    });
    runtime.onReload((config) => orchestrator.notifyConfigReload(config));
    this.orchestrator = orchestrator;
    await orchestrator.start();

    const serverPort = runtime.getConfig().server.port;
    let http: { host: string; port: number } | undefined;
    if (serverPort !== null) {
      this.httpServer = createHttpStatusServer({
        host: runtime.getConfig().server.host,
        port: serverPort,
        orchestrator,
        logger: this.logger
      });
      http = await this.httpServer.start();
    }
    return http ? { http } : {};
  }

  async stop(): Promise<void> {
    await this.httpServer?.close();
    await this.orchestrator?.stop();
    this.workflowRuntime?.close();
  }

  getOrchestrator(): Orchestrator {
    if (!this.orchestrator) throw new Error("Symphony service has not started");
    return this.orchestrator;
  }
}

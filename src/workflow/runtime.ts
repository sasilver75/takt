import { watch, type FSWatcher } from "node:fs";
import type { SymphonyConfig, WorkflowDefinition } from "../domain.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { resolveConfig, validateDispatchConfig } from "../config/config.js";
import { loadWorkflow } from "./loader.js";

export type WorkflowRuntimeOptions = {
  workflowPath: string;
  env?: Record<string, string | undefined> | undefined;
  portOverride?: number | null | undefined;
  logger: Logger;
};

export class WorkflowRuntime {
  private workflow: WorkflowDefinition | null = null;
  private config: SymphonyConfig | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(config: SymphonyConfig, workflow: WorkflowDefinition) => void>();

  constructor(private readonly options: WorkflowRuntimeOptions) {}

  async start(): Promise<void> {
    await this.reload({ validate: true, throwOnError: true });
    this.watcher = watch(this.options.workflowPath, { persistent: false }, () => {
      this.scheduleReload();
    });
  }

  close(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  getWorkflow(): WorkflowDefinition {
    if (!this.workflow) throw new Error("Workflow runtime has not loaded a workflow");
    return this.workflow;
  }

  getConfig(): SymphonyConfig {
    if (!this.config) throw new Error("Workflow runtime has not loaded config");
    return this.config;
  }

  onReload(listener: (config: SymphonyConfig, workflow: WorkflowDefinition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshForOperation(): Promise<void> {
    await this.reload({ validate: false, throwOnError: false });
  }

  async validateDispatch(): Promise<void> {
    await this.reload({ validate: false, throwOnError: false });
    validateDispatchConfig(this.getConfig());
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      void this.reload({ validate: false, throwOnError: false });
    }, 50);
  }

  private async reload(options: { validate: boolean; throwOnError: boolean }): Promise<void> {
    try {
      const workflow = await loadWorkflow(this.options.workflowPath);
      const overrides = this.options.portOverride === undefined ? {} : { port: this.options.portOverride };
      const config = resolveConfig(workflow, this.options.env, overrides);
      if (options.validate) validateDispatchConfig(config);
      this.workflow = workflow;
      this.config = config;
      this.options.logger.info("workflow reload completed", { workflow_path: workflow.path });
      for (const listener of this.listeners) listener(config, workflow);
    } catch (error) {
      this.options.logger.error("workflow reload failed", { error: errorMessage(error) });
      if (options.throwOnError) throw error;
    }
  }
}

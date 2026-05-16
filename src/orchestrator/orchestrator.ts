import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexRuntimeEvent,
  Issue,
  IssueDebugRecord,
  GraphqlToolExecutor,
  RetryEntry,
  RuntimeEvent,
  RuntimeState,
  RunningEntry,
  PullRequestPublisher,
  PrReadyManifest,
  SymphonyConfig,
  TrackerClient,
  WorkflowDefinition
} from "../domain.js";
import { errorMessage } from "../errors.js";
import { isActiveState, isTerminalState, normalizeState } from "../config/config.js";
import type { Logger } from "../observability/logger.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { AgentRunHandle } from "../agent/runner.js";
import type { LinearGraphqlBridgeHandle, LinearGraphqlBridgeStartOptions } from "../agent/linearGraphqlBridge.js";

export type OrchestratorOptions = {
  getConfig: () => SymphonyConfig;
  getWorkflow: () => WorkflowDefinition;
  validateDispatch: () => Promise<void>;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  logger: Logger;
  linearTool?: GraphqlToolExecutor | null | undefined;
  linearBridgeFactory?: ((options: LinearGraphqlBridgeStartOptions) => Promise<LinearGraphqlBridgeHandle | null>) | null | undefined;
  pullRequestPublisher?: PullRequestPublisher | null | undefined;
};

export class Orchestrator {
  readonly state: RuntimeState;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly options: OrchestratorOptions) {
    const config = options.getConfig();
    this.state = {
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
      recent_events: [],
      issue_history: new Map()
    };
  }

  async start(): Promise<void> {
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const retry of this.state.retry_attempts.values()) {
      if (retry.timer_handle) clearTimeout(retry.timer_handle);
    }
    await Promise.all([...this.state.running.values()].map((entry) => Promise.resolve(entry.terminate("orchestrator stopped"))));
  }

  notifyConfigReload(config: SymphonyConfig): void {
    this.state.poll_interval_ms = config.polling.interval_ms;
    this.state.max_concurrent_agents = config.agent.max_concurrent_agents;
  }

  queueImmediateTick(): { queued: boolean; coalesced: boolean } {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
      this.scheduleTick(0);
      return { queued: true, coalesced: true };
    }
    this.scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.notifyConfigReload(this.options.getConfig());
      await this.reconcileRunningIssues();
      try {
        await this.options.validateDispatch();
      } catch (error) {
        this.options.logger.error("dispatch validation failed", { error: errorMessage(error) });
        return;
      }

      let issues: Issue[];
      try {
        issues = await this.options.tracker.fetchCandidateIssues();
      } catch (error) {
        this.options.logger.error("candidate fetch failed", { error: errorMessage(error) });
        return;
      }

      for (const issue of sortForDispatch(issues)) {
        if (this.availableGlobalSlots() <= 0) break;
        if (this.shouldDispatch(issue)) await this.dispatchIssue(issue, null);
      }
    } finally {
      this.ticking = false;
      if (!this.stopped) this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  snapshot(): unknown {
    const now = Date.now();
    const running = [...this.state.running.entries()].map(([issueId, entry]) => ({
      issue_id: issueId,
      issue_identifier: entry.identifier,
      state: entry.issue.state,
      session_id: entry.session_id,
      turn_count: entry.turn_count,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      started_at: entry.started_at,
      last_event_at: entry.last_codex_timestamp,
      tokens: {
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens
      }
    }));
    const retrying = [...this.state.retry_attempts.values()].map((retry) => ({
      issue_id: retry.issue_id,
      issue_identifier: retry.identifier,
      attempt: retry.attempt,
      due_at: new Date(retry.due_at_ms).toISOString(),
      error: retry.error
    }));
    const activeSeconds = [...this.state.running.values()].reduce((sum, entry) => sum + (now - entry.started_at_ms) / 1000, 0);
    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: running.length, retrying: retrying.length, completed: this.state.completed.size },
      running,
      retrying,
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeSeconds
      },
      rate_limits: this.state.codex_rate_limits
    };
  }

  issueSnapshot(identifier: string): unknown | null {
    const running = [...this.state.running.values()].find((entry) => entry.identifier === identifier);
    const retry = [...this.state.retry_attempts.values()].find((entry) => entry.identifier === identifier) ?? null;
    const record = this.state.issue_history.get(identifier);
    if (!running && !retry && !record) return null;
    return {
      issue_identifier: identifier,
      issue_id: running?.issue.id ?? retry?.issue_id ?? record?.issue_id,
      status: running ? "running" : retry ? "retrying" : record && this.state.completed.has(record.issue_id) ? "completed" : "known",
      workspace: { path: running?.workspace_path ?? record?.workspace_path ?? null },
      attempts: {
        restart_count: record?.restart_count ?? 0,
        current_retry_attempt: retry?.attempt ?? null
      },
      running: running
        ? {
            session_id: running.session_id,
            turn_count: running.turn_count,
            state: running.issue.state,
            started_at: running.started_at,
            last_event: running.last_codex_event,
            last_message: running.last_codex_message,
            last_event_at: running.last_codex_timestamp,
            tokens: {
              input_tokens: running.codex_input_tokens,
              output_tokens: running.codex_output_tokens,
              total_tokens: running.codex_total_tokens
            }
          }
        : null,
      retry,
      logs: { codex_session_logs: [] },
      recent_events: record?.recent_events ?? [],
      last_error: record?.last_error ?? null,
      tracked: record?.tracked ?? {}
    };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.options.tracker.fetchIssuesByStates(this.options.getConfig().tracker.terminal_states);
      for (const issue of terminalIssues) await this.options.workspaceManager.removeForIssue(issue.identifier);
    } catch (error) {
      this.options.logger.warn("startup terminal workspace cleanup failed", { error: errorMessage(error) });
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalls();
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.options.logger.warn("running state refresh failed", { error: errorMessage(error) });
      return;
    }
    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const issueId of runningIds) {
      const issue = byId.get(issueId);
      const entry = this.state.running.get(issueId);
      if (!entry || !issue) continue;
      if (isTerminalState(issue.state, this.options.getConfig())) {
        await this.terminateRunning(issueId, "terminal tracker state", true);
      } else if (isActiveState(issue.state, this.options.getConfig())) {
        entry.issue = issue;
      } else {
        await this.terminateRunning(issueId, "non-active tracker state", false);
      }
    }
  }

  private reconcileStalls(): void {
    const timeout = this.options.getConfig().codex.stall_timeout_ms;
    if (timeout <= 0) return;
    const now = Date.now();
    for (const [issueId, entry] of this.state.running.entries()) {
      const last = entry.last_codex_timestamp_ms ?? entry.started_at_ms;
      if (now - last > timeout) {
        void this.terminateRunning(issueId, "stalled session", false);
        this.scheduleRetry(issueId, nextAttempt(entry.retry_attempt), entry.identifier, "stalled session", false);
      }
    }
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!isActiveState(issue.state, this.options.getConfig())) return false;
    if (isTerminalState(issue.state, this.options.getConfig())) return false;
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return false;
    if (this.availableGlobalSlots() <= 0) return false;
    if (this.availableStateSlots(issue.state) <= 0) return false;
    if (normalizeState(issue.state) === "todo") {
      const terminalStates = new Set(this.options.getConfig().tracker.terminal_states.map(normalizeState));
      if (issue.blocked_by.some((blocker) => !blocker.state || !terminalStates.has(normalizeState(blocker.state)))) return false;
    }
    return true;
  }

  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    this.state.claimed.add(issue.id);
    let runIssue = issue;
    try {
      runIssue = await this.claimIssue(issue);
    } catch (error) {
      this.state.claimed.delete(issue.id);
      const message = errorMessage(error);
      this.ensureRecord(issue).last_error = message;
      this.scheduleRetry(issue.id, nextAttempt(attempt), issue.identifier, message, false);
      this.recordEvent({ at: new Date().toISOString(), event: "claim_failed", issue_id: issue.id, issue_identifier: issue.identifier, message });
      return;
    }
    const handle = new AgentRunHandle({
      issue: runIssue,
      attempt,
      getConfig: this.options.getConfig,
      getWorkflow: this.options.getWorkflow,
      workspaceManager: this.options.workspaceManager,
      tracker: this.options.tracker,
      logger: this.options.logger,
      linearTool: this.options.linearTool,
      linearBridgeFactory: this.options.linearBridgeFactory,
      onEvent: (event) => this.onCodexEvent(issue.id, event)
    });
    const startedAtMs = Date.now();
    const entry: RunningEntry = {
      issue: runIssue,
      identifier: runIssue.identifier,
      started_at_ms: startedAtMs,
      started_at: new Date(startedAtMs).toISOString(),
      retry_attempt: attempt,
      workspace_path: this.options.workspaceManager.workspacePath(runIssue.identifier),
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp_ms: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      terminate: (reason) => handle.terminate(reason)
    };
    this.state.running.set(runIssue.id, entry);
    this.state.retry_attempts.delete(runIssue.id);
    this.ensureRecord(runIssue).restart_count += attempt ? 1 : 0;
    this.recordEvent({ at: new Date().toISOString(), event: "dispatch", issue_id: runIssue.id, issue_identifier: runIssue.identifier });
    void handle.run().then((result) => void this.onWorkerExit(runIssue.id, result));
  }

  private onCodexEvent(issueId: string, event: CodexRuntimeEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    entry.codex_app_server_pid = event.codex_app_server_pid ?? entry.codex_app_server_pid;
    entry.session_id = event.session_id ?? entry.session_id;
    entry.thread_id = event.thread_id ?? entry.thread_id;
    entry.turn_id = event.turn_id ?? entry.turn_id;
    entry.last_codex_event = event.event;
    entry.last_codex_timestamp = event.timestamp;
    entry.last_codex_timestamp_ms = Date.parse(event.timestamp);
    entry.last_codex_message = event.message ?? summarizeRaw(event.raw);
    if (event.event === "turn/started") entry.turn_count += 1;
    if (event.absolute_usage) {
      const input = event.absolute_usage.input_tokens ?? entry.last_reported_input_tokens;
      const output = event.absolute_usage.output_tokens ?? entry.last_reported_output_tokens;
      const total = event.absolute_usage.total_tokens ?? input + output;
      this.state.codex_totals.input_tokens += Math.max(input - entry.last_reported_input_tokens, 0);
      this.state.codex_totals.output_tokens += Math.max(output - entry.last_reported_output_tokens, 0);
      this.state.codex_totals.total_tokens += Math.max(total - entry.last_reported_total_tokens, 0);
      entry.last_reported_input_tokens = input;
      entry.last_reported_output_tokens = output;
      entry.last_reported_total_tokens = total;
      entry.codex_input_tokens = input;
      entry.codex_output_tokens = output;
      entry.codex_total_tokens = total;
    }
    if (event.rate_limits !== undefined) this.state.codex_rate_limits = event.rate_limits;
    this.recordEvent({
      at: event.timestamp,
      event: event.event,
      issue_id: issueId,
      issue_identifier: entry.identifier,
      session_id: entry.session_id,
      message: entry.last_codex_message
    });
  }

  private async onWorkerExit(issueId: string, result: { ok: boolean; runtime_seconds: number; error?: string; workspace_path?: string }): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    this.state.running.delete(issueId);
    this.state.codex_totals.seconds_running += result.runtime_seconds;
    const record = this.ensureRecord(entry.issue);
    record.workspace_path = result.workspace_path ?? entry.workspace_path;
    if (result.ok) {
      if (await this.tryPublishPullRequest(entry.issue, record.workspace_path)) {
        this.state.completed.add(issueId);
        this.state.claimed.delete(issueId);
      } else {
        this.state.completed.add(issueId);
        this.scheduleRetry(issueId, 1, entry.identifier, record.last_error, true);
      }
    } else {
      record.last_error = result.error ?? "worker failed";
      this.scheduleRetry(issueId, nextAttempt(entry.retry_attempt), entry.identifier, record.last_error, false);
    }
    this.recordEvent({
      at: new Date().toISOString(),
      event: result.ok ? "worker_exit_normal" : "worker_exit_abnormal",
      issue_id: issueId,
      issue_identifier: entry.identifier,
      message: result.error ?? null
    });
  }

  private async claimIssue(issue: Issue): Promise<Issue> {
    const claimState = this.options.getConfig().tracker.claim_state;
    if (!claimState || normalizeState(issue.state) === normalizeState(claimState)) return issue;
    if (!this.options.tracker.transitionIssue) throw new Error("Tracker does not support issue state transitions");
    const updated = await this.options.tracker.transitionIssue(issue, claimState);
    this.recordEvent({
      at: new Date().toISOString(),
      event: "issue_claimed",
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      message: claimState
    });
    return updated;
  }

  private async tryPublishPullRequest(issue: Issue, workspacePath: string | null): Promise<boolean> {
    const config = this.options.getConfig();
    if (!config.github.enabled || !this.options.pullRequestPublisher || !workspacePath) return false;
    try {
      const manifest = await readPrReadyManifest(workspacePath, config.github.pr_ready_file);
      if (!manifest) return false;
      const published = await this.options.pullRequestPublisher.publish({ issue, workspacePath, manifest });
      const record = this.ensureRecord(issue);
      record.tracked.github_pull_request = published;
      await this.options.tracker.commentOnIssue?.(issue, `Published PR: ${published.url}`);
      if (config.tracker.review_state) {
        if (!this.options.tracker.transitionIssue) throw new Error("Tracker does not support issue state transitions");
        await this.options.tracker.transitionIssue(issue, config.tracker.review_state);
      }
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_published",
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        message: published.url
      });
      return true;
    } catch (error) {
      const message = errorMessage(error);
      this.ensureRecord(issue).last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_publish_failed",
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        message
      });
      return false;
    }
  }

  private scheduleRetry(issueId: string, attempt: number, identifier: string, error: string | null, continuation: boolean): void {
    const existing = this.state.retry_attempts.get(issueId);
    if (existing?.timer_handle) clearTimeout(existing.timer_handle);
    const delay = continuation ? 1000 : Math.min(10000 * 2 ** (attempt - 1), this.options.getConfig().agent.max_retry_backoff_ms);
    const dueAt = Date.now() + delay;
    const retry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: dueAt,
      timer_handle: setTimeout(() => void this.onRetryTimer(issueId), delay),
      error
    };
    this.state.retry_attempts.set(issueId, retry);
    this.state.claimed.add(issueId);
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);
    let candidates: Issue[];
    try {
      candidates = await this.options.tracker.fetchCandidateIssues();
    } catch {
      this.scheduleRetry(issueId, retry.attempt + 1, retry.identifier, "retry poll failed", false);
      return;
    }
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      return;
    }
    if (!this.shouldDispatchIgnoringClaim(issue)) {
      this.scheduleRetry(issueId, retry.attempt + 1, issue.identifier, "no available orchestrator slots", false);
      return;
    }
    this.state.claimed.delete(issueId);
    this.dispatchIssue(issue, retry.attempt);
  }

  private shouldDispatchIgnoringClaim(issue: Issue): boolean {
    const wasClaimed = this.state.claimed.delete(issue.id);
    const ok = this.shouldDispatch(issue);
    if (wasClaimed) this.state.claimed.add(issue.id);
    return ok;
  }

  private async terminateRunning(issueId: string, reason: string, cleanupWorkspace: boolean): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    await Promise.resolve(entry.terminate(reason));
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
    if (cleanupWorkspace) await this.options.workspaceManager.removeForIssue(entry.identifier);
  }

  private availableGlobalSlots(): number {
    return Math.max(this.options.getConfig().agent.max_concurrent_agents - this.state.running.size, 0);
  }

  private availableStateSlots(state: string): number {
    const normalized = normalizeState(state);
    const max = this.options.getConfig().agent.max_concurrent_agents_by_state[normalized] ?? this.options.getConfig().agent.max_concurrent_agents;
    const runningInState = [...this.state.running.values()].filter((entry) => normalizeState(entry.issue.state) === normalized).length;
    return Math.max(max - runningInState, 0);
  }

  private ensureRecord(issue: Issue): IssueDebugRecord {
    const existing = this.state.issue_history.get(issue.identifier);
    if (existing) return existing;
    const record: IssueDebugRecord = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace_path: null,
      restart_count: 0,
      last_error: null,
      recent_events: [],
      tracked: {}
    };
    this.state.issue_history.set(issue.identifier, record);
    return record;
  }

  private recordEvent(event: RuntimeEvent): void {
    this.state.recent_events.push(event);
    if (this.state.recent_events.length > 200) this.state.recent_events.splice(0, this.state.recent_events.length - 200);
    if (event.issue_identifier) {
      const record = this.state.issue_history.get(event.issue_identifier);
      if (record) {
        record.recent_events.push(event);
        if (record.recent_events.length > 50) record.recent_events.splice(0, record.recent_events.length - 50);
      }
    }
    this.options.logger.info(event.event, {
      issue_id: event.issue_id,
      issue_identifier: event.issue_identifier,
      session_id: event.session_id,
      message: event.message
    });
  }
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const createdB = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (createdA !== createdB) return createdA - createdB;
    return a.identifier.localeCompare(b.identifier);
  });
}

function nextAttempt(current: number | null): number {
  return current === null ? 1 : current + 1;
}

async function readPrReadyManifest(workspacePath: string, fileName: string): Promise<PrReadyManifest | null> {
  try {
    const raw = await readFile(path.join(workspacePath, fileName), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be a JSON object");
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(typeof record.body === "string" ? { body: record.body } : {}),
      ...(Array.isArray(record.verification) ? { verification: record.verification.filter((entry): entry is string => typeof entry === "string") } : {}),
      ...(typeof record.risk === "string" ? { risk: record.risk } : {})
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function summarizeRaw(raw: unknown): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(raw).slice(0, 500);
  } catch {
    return String(raw).slice(0, 500);
  }
}

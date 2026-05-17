import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexRuntimeEvent,
  DiscoveredPullRequest,
  DurableStateSnapshot,
  DurableStateStore,
  EvidenceArtifact,
  EvidenceCommand,
  EvidenceManifest,
  Issue,
  IssueDebugRecord,
  GraphqlToolExecutor,
  RetryEntry,
  RuntimeEvent,
  RuntimeState,
  RunningEntry,
  PublishedPullRequest,
  PullRequestMerger,
  PullRequestInspection,
  PullRequestEvidencePublisher,
  PullRequestPublisher,
  PullRequestTracker,
  PrReadyManifest,
  RunAttemptRecord,
  SymphonyConfig,
  TrackerClient,
  WorkflowDefinition
} from "../domain.js";
import { errorMessage, SymphonyError } from "../errors.js";
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
  pullRequestTracker?: PullRequestTracker | null | undefined;
  pullRequestMerger?: PullRequestMerger | null | undefined;
  pullRequestEvidencePublisher?: PullRequestEvidencePublisher | null | undefined;
  durableStore?: DurableStateStore | null | undefined;
};

export type OrchestratorStartOptions = {
  schedule?: boolean;
};

export class Orchestrator {
  readonly state: RuntimeState;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private persistenceChain: Promise<void> = Promise.resolve();
  private closedPullRequestRecoveryDone = false;

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

  async start(options: OrchestratorStartOptions = {}): Promise<void> {
    await this.restoreDurableState();
    await this.startupCleanup();
    if (options.schedule !== false) this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const retry of this.state.retry_attempts.values()) {
      if (retry.timer_handle) clearTimeout(retry.timer_handle);
    }
    await Promise.all([...this.state.running.values()].map((entry) => Promise.resolve(entry.terminate("orchestrator stopped"))));
    this.persistState();
    await this.flushPersistence();
  }

  notifyConfigReload(config: SymphonyConfig): void {
    this.state.poll_interval_ms = config.polling.interval_ms;
    this.state.max_concurrent_agents = config.agent.max_concurrent_agents;
    this.trimObservabilityState(config);
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
      await this.reconcileLifecycle();
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
        if (this.shouldDispatch(issue)) await this.dispatchIssue(issue, null, null);
      }
    } finally {
      this.ticking = false;
      if (!this.stopped) this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  async reconcileOnce(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcileLifecycle();
    } finally {
      this.ticking = false;
    }
  }

  snapshot(): unknown {
    const now = Date.now();
    const config = this.options.getConfig();
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
      error: retry.error,
      context: retry.context
    }));
    const pullRequests = [...this.state.issue_history.values()]
      .map((record) => {
        const pr = readTrackedPullRequest(record.tracked.github_pull_request);
        if (!pr) return null;
        return {
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          pull_request: pr,
          status: record.tracked.github_pull_request_status ?? null,
          evidence: readTrackedEvidence(record.tracked)
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const activeSeconds = [...this.state.running.values()].reduce((sum, entry) => sum + (now - entry.started_at_ms) / 1000, 0);
    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: running.length, retrying: retrying.length, completed: this.state.completed.size, pull_requests: pullRequests.length },
      running,
      retrying,
      pull_requests: pullRequests,
      recent_events: this.state.recent_events.slice(-config.observability.recent_event_limit),
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeSeconds
      },
      rate_limits: this.state.codex_rate_limits
    };
  }

  issueSnapshot(identifier: string): unknown | null {
    const config = this.options.getConfig();
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
        current_retry_attempt: retry?.attempt ?? null,
        run_attempts: record?.run_attempts ?? []
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
      recent_events: record?.recent_events.slice(-config.observability.issue_event_limit) ?? [],
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

  private async reconcileLifecycle(): Promise<void> {
    this.notifyConfigReload(this.options.getConfig());
    await this.reconcileRunningIssues();
    await this.recoverPullRequests();
    await this.reconcilePullRequests();
  }

  private async restoreDurableState(): Promise<void> {
    if (!this.options.durableStore) return;
    const snapshot = await this.options.durableStore.load();
    if (!snapshot) return;
    const config = this.options.getConfig();
    this.state.completed = new Set(snapshot.completed_issue_ids);
    this.state.codex_totals = snapshot.codex_totals;
    this.state.codex_rate_limits = snapshot.codex_rate_limits;
    this.state.recent_events = snapshot.recent_events.slice(-config.observability.recent_event_limit);
    const restoredAt = new Date().toISOString();
    this.state.issue_history = new Map(snapshot.issue_history.map((record) => [record.issue_identifier, this.trimIssueRecord(this.markInterruptedAttempts(record, restoredAt), config)]));
    for (const retry of snapshot.retry_attempts) {
      if (this.state.completed.has(retry.issue_id)) continue;
      const delay = Math.max(retry.due_at_ms - Date.now(), 0);
      this.state.retry_attempts.set(retry.issue_id, {
        ...retry,
        timer_handle: setTimeout(() => void this.onRetryTimer(retry.issue_id), delay)
      });
      this.state.claimed.add(retry.issue_id);
    }
    this.options.logger.info("durable state restored", {
      retrying: this.state.retry_attempts.size,
      completed: this.state.completed.size,
      issue_history: this.state.issue_history.size
    });
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

  private async recoverPullRequests(): Promise<void> {
    if (!this.options.getConfig().github.enabled || !this.options.pullRequestTracker) return;
    const discoveryStates: Array<"open" | "closed"> = this.closedPullRequestRecoveryDone ? ["open"] : ["open", "closed"];
    let discovered: DiscoveredPullRequest[];
    try {
      discovered = this.options.pullRequestTracker.discoverManaged
        ? await this.options.pullRequestTracker.discoverManaged({ states: [...discoveryStates] })
        : this.options.pullRequestTracker.discoverOpen
          ? await this.options.pullRequestTracker.discoverOpen()
          : [];
      this.closedPullRequestRecoveryDone = this.closedPullRequestRecoveryDone || discoveryStates.includes("closed");
    } catch (error) {
      this.options.logger.warn("github pr discovery failed", { error: errorMessage(error) });
      return;
    }
    const unknown = discovered.filter((pr) => !this.hasTrackedPullRequest(pr.number));
    if (unknown.length === 0) return;
    const issues = await this.fetchIssuesForDiscoveredPullRequests(unknown);
    const byIdentifier = new Map(issues.map((issue) => [issue.identifier.toUpperCase(), issue]));
    for (const pullRequest of unknown) {
      const issue = byIdentifier.get(pullRequest.issue_identifier.toUpperCase());
      if (!issue) {
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_recovery_skipped",
          issue_identifier: pullRequest.issue_identifier,
          message: `No tracker issue found for ${pullRequest.url}`
        });
        continue;
      }
      const record = this.ensureRecord(issue);
      if (readTrackedPullRequest(record.tracked.github_pull_request)) continue;
      record.workspace_path = this.options.workspaceManager.workspacePath(issue.identifier);
      record.tracked.github_pull_request = pullRequest;
      record.tracked.github_pr_recovered = true;
      record.tracked.github_pr_recovered_at = new Date().toISOString();
      record.last_error = null;
      this.state.completed.add(issue.id);
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_recovered",
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        message: pullRequest.url
      });
    }
  }

  private async fetchIssuesForDiscoveredPullRequests(pullRequests: DiscoveredPullRequest[]): Promise<Issue[]> {
    const identifiers = [...new Set(pullRequests.map((pr) => pr.issue_identifier))];
    if (this.options.tracker.fetchIssuesByIdentifiers) {
      try {
        return await this.options.tracker.fetchIssuesByIdentifiers(identifiers);
      } catch (error) {
        this.options.logger.warn("tracker identifier fetch failed", { error: errorMessage(error) });
      }
    }
    const states = new Set<string>([
      ...this.options.getConfig().tracker.active_states,
      ...this.options.getConfig().tracker.terminal_states,
      this.options.getConfig().tracker.claim_state ?? "",
      this.options.getConfig().tracker.review_state ?? ""
    ].filter(Boolean));
    if (states.size === 0) return [];
    try {
      const issues = await this.options.tracker.fetchIssuesByStates([...states]);
      const wanted = new Set(identifiers.map((identifier) => identifier.toUpperCase()));
      return issues.filter((issue) => wanted.has(issue.identifier.toUpperCase()));
    } catch (error) {
      this.options.logger.warn("tracker recovery state fetch failed", { error: errorMessage(error) });
      return [];
    }
  }

  private hasTrackedPullRequest(number: number): boolean {
    for (const record of this.state.issue_history.values()) {
      const tracked = readTrackedPullRequest(record.tracked.github_pull_request);
      if (tracked?.number === number) return true;
    }
    return false;
  }

  private async reconcilePullRequests(): Promise<void> {
    const config = this.options.getConfig();
    if (!config.github.enabled || !this.options.pullRequestTracker) return;
    for (const record of this.state.issue_history.values()) {
      const pullRequest = readTrackedPullRequest(record.tracked.github_pull_request);
      if (!pullRequest) continue;
      if (!isManagedPullRequestBranch(pullRequest, config)) continue;
      if (this.state.running.has(record.issue_id) || this.state.retry_attempts.has(record.issue_id)) continue;
      let inspection: PullRequestInspection;
      try {
        inspection = await this.options.pullRequestTracker.inspect(pullRequest);
      } catch (error) {
        const message = errorMessage(error);
        record.last_error = message;
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_inspect_failed",
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message
        });
        continue;
      }
      record.last_error = null;
      record.tracked.github_pull_request_status = inspection;
      const statusKey = pullRequestStatusKey(inspection);
      if (record.tracked.github_pr_status_key !== statusKey) {
        record.tracked.github_pr_status_key = statusKey;
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_reconciled",
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message: inspection.summary
        });
      }
      if (inspection.state === "merged" || inspection.state === "closed") {
        this.state.completed.add(record.issue_id);
        record.tracked.github_pr_terminal_state = inspection.state;
        record.tracked.github_pr_terminal_checked_at = inspection.checked_at;
        if (inspection.state === "merged") await this.ensureIssueCompletionState(record, null, "pull_request_reconcile", false);
        this.persistState();
        continue;
      }
      const feedback = pullRequestFollowupFeedback(inspection, readHandledPullRequestFollowupKeys(record));
      if (feedback.length > 0) await this.queuePullRequestFollowup(record, pullRequest, inspection, feedback);
      else if (this.shouldMergePullRequest(inspection)) await this.tryMergePullRequest(record, pullRequest, inspection);
      else {
        await this.ensureIssueReviewState(record, null, "pull_request_reconcile", false);
        this.persistState();
      }
    }
  }

  private async queuePullRequestFollowup(
    record: IssueDebugRecord,
    pullRequest: PublishedPullRequest,
    inspection: PullRequestInspection,
    feedback: PullRequestFeedback[]
  ): Promise<void> {
    const reason = uniqueStrings(feedback.map((item) => item.reason)).join("; ");
    let issue: Issue | null = null;
    try {
      const refreshed = await this.options.tracker.fetchIssueStatesByIds([record.issue_id]);
      issue = refreshed[0] ?? null;
    } catch (error) {
      const message = errorMessage(error);
      record.last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_followup_failed",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message
      });
      return;
    }
    if (!issue) {
      record.last_error = "Tracked issue could not be refreshed for PR follow-up";
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_followup_failed",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: record.last_error
      });
      return;
    }

    const context = renderPullRequestFollowupContext(record, pullRequest, inspection, reason, this.options.getConfig().github.pr_ready_file);
    await this.options.tracker.commentOnIssue?.(issue, `PR follow-up queued:\n\n${context}`).catch((error: unknown) => {
      this.options.logger.warn("failed to comment on PR follow-up", { issue_id: issue?.id, error: errorMessage(error) });
    });

    let dispatchIssue = issue;
    const config = this.options.getConfig();
    if (!isActiveState(dispatchIssue.state, config)) {
      const claimState = config.tracker.claim_state;
      if (!claimState || !this.options.tracker.transitionIssue) {
        const message = "PR follow-up requires tracker.claim_state and transition support";
        record.last_error = message;
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_followup_failed",
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message
        });
        return;
      }
      try {
        dispatchIssue = await this.options.tracker.transitionIssue(dispatchIssue, claimState);
      } catch (error) {
        const message = errorMessage(error);
        record.last_error = message;
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_followup_failed",
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message
        });
        return;
      }
    }

    const attempt = nextAttempt(record.restart_count === 0 ? null : record.restart_count);
    record.tracked.github_pr_inflight_followup_keys = feedback.map((item) => item.key).sort();
    record.tracked.github_pr_last_followup_key = `feedback:${feedback.map((item) => item.key).sort().join("|")}`;
    record.tracked.github_pr_followup_reason = reason;
    record.tracked.github_pr_followup_context = context;
    record.last_error = null;
    this.state.completed.delete(record.issue_id);
    this.state.claimed.delete(record.issue_id);
    if (this.shouldDispatch(dispatchIssue)) {
      await this.dispatchIssue(dispatchIssue, attempt, context);
    } else {
      this.scheduleRetry(record.issue_id, attempt, record.issue_identifier, reason, false, context);
    }
    this.recordEvent({
      at: new Date().toISOString(),
      event: "pull_request_followup_queued",
      issue_id: record.issue_id,
      issue_identifier: record.issue_identifier,
      message: reason
    });
  }

  private shouldMergePullRequest(inspection: PullRequestInspection): boolean {
    const merge = this.options.getConfig().github.merge;
    if (!merge.enabled || !this.options.pullRequestMerger) return false;
    if (inspection.state !== "open" || inspection.draft) return false;
    if (merge.require_successful_checks && inspection.checks_status !== "success") return false;
    if (merge.require_approval && inspection.review_status !== "approved") return false;
    if (merge.require_clean_merge && normalizeMergeableState(inspection.mergeable_state) !== "clean") return false;
    return true;
  }

  private async tryMergePullRequest(record: IssueDebugRecord, pullRequest: PublishedPullRequest, inspection: PullRequestInspection): Promise<void> {
    if (!this.options.pullRequestMerger) return;
    try {
      const result = await this.options.pullRequestMerger.merge({ pullRequest, inspection });
      record.tracked.github_pull_request_merge = result;
      if (!result.merged) {
        record.last_error = result.message ?? "GitHub reported that the PR was not merged";
        this.recordEvent({
          at: new Date().toISOString(),
          event: "pull_request_merge_failed",
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message: record.last_error
        });
        return;
      }
      record.last_error = null;
      record.tracked.github_pr_terminal_state = "merged";
      record.tracked.github_pr_merged_at = new Date().toISOString();
      this.state.completed.add(record.issue_id);
      await this.ensureIssueCompletionState(record, null, "pull_request_merge", false);
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_merged",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: pullRequest.url
      });
      this.persistState();
    } catch (error) {
      const message = errorMessage(error);
      record.last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_merge_failed",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message
      });
      this.persistState();
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
        this.scheduleRetry(issueId, nextAttempt(entry.retry_attempt), entry.identifier, "stalled session", false, null);
      }
    }
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.state.completed.has(issue.id)) return false;
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

  private async dispatchIssue(issue: Issue, attempt: number | null, followupContext: string | null): Promise<void> {
    this.state.claimed.add(issue.id);
    let runIssue = issue;
    try {
      runIssue = await this.claimIssue(issue);
    } catch (error) {
      this.state.claimed.delete(issue.id);
      const message = errorMessage(error);
      this.ensureRecord(issue).last_error = message;
      this.scheduleRetry(issue.id, nextAttempt(attempt), issue.identifier, message, false, followupContext);
      this.recordEvent({ at: new Date().toISOString(), event: "claim_failed", issue_id: issue.id, issue_identifier: issue.identifier, message });
      return;
    }
    const handle = new AgentRunHandle({
      issue: runIssue,
      attempt,
      followupContext,
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
    const record = this.ensureRecord(runIssue);
    record.restart_count += attempt ? 1 : 0;
    this.startRunAttempt(record, entry, followupContext);
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
    this.finishRunAttempt(record, entry, result);
    if (result.ok) {
      if (await this.tryPublishPullRequest(entry.issue, record.workspace_path)) {
        this.state.completed.add(issueId);
        this.state.claimed.delete(issueId);
        this.persistState();
      } else {
        this.scheduleRetry(issueId, 1, entry.identifier, record.last_error, true, null);
      }
    } else {
      record.last_error = result.error ?? "worker failed";
      this.scheduleRetry(issueId, nextAttempt(entry.retry_attempt), entry.identifier, record.last_error, false, null);
    }
    this.recordEvent({
      at: new Date().toISOString(),
      event: result.ok ? "worker_exit_normal" : "worker_exit_abnormal",
      issue_id: issueId,
      issue_identifier: entry.identifier,
      message: result.error ?? null
    });
    this.persistState();
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
      const evidenceManifest = await this.readEvidenceManifestForPublish(workspacePath, config.github.evidence_file);
      const published = await this.options.pullRequestPublisher.publish({ issue, workspacePath, manifest, evidenceManifest });
      const record = this.ensureRecord(issue);
      const previousPullRequest = readTrackedPullRequest(record.tracked.github_pull_request);
      record.tracked.github_pull_request = published;
      await this.publishPullRequestEvidence(record, published, workspacePath);
      await this.commentPublishedPullRequestLink(record, issue, published, previousPullRequest);
      await this.ensureIssueReviewState(record, issue, "pull_request_publish", true);
      this.markPullRequestFollowupHandled(record);
      record.last_error = null;
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

  private async commentPublishedPullRequestLink(
    record: IssueDebugRecord,
    issue: Issue,
    published: PublishedPullRequest,
    previousPullRequest: PublishedPullRequest | null
  ): Promise<void> {
    if (!this.options.tracker.commentOnIssue) return;
    const alreadyCommented =
      record.tracked.github_pr_link_commented_number === published.number || record.tracked.github_pr_link_commented_url === published.url;
    const unchangedExistingPr = previousPullRequest?.number === published.number && previousPullRequest.url === published.url && !published.created;
    if (alreadyCommented || unchangedExistingPr) return;
    await this.options.tracker.commentOnIssue(issue, `Published PR: ${published.url}`);
    record.tracked.github_pr_link_commented_number = published.number;
    record.tracked.github_pr_link_commented_url = published.url;
    record.tracked.github_pr_link_commented_at = new Date().toISOString();
  }

  private async publishPullRequestEvidence(record: IssueDebugRecord, pullRequest: PublishedPullRequest, workspacePath: string): Promise<void> {
    if (!this.options.pullRequestEvidencePublisher) return;
    const config = this.options.getConfig();
    let manifest: EvidenceManifest | null = null;
    try {
      manifest = await readEvidenceManifest(workspacePath, config.github.evidence_file);
    } catch (error) {
      const message = errorMessage(error);
      record.tracked.github_evidence_last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_evidence_failed",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message
      });
      return;
    }
    if (!manifest) return;

    try {
      const previousCommentId = typeof record.tracked.github_evidence_comment_id === "number" ? record.tracked.github_evidence_comment_id : null;
      const published = await this.options.pullRequestEvidencePublisher.publish({ pullRequest, workspacePath, manifest, previousCommentId });
      record.tracked.github_evidence_comment_id = published.comment_id;
      record.tracked.github_evidence_comment_url = published.url;
      record.tracked.github_evidence_published_at = new Date().toISOString();
      record.tracked.github_evidence_manifest = manifest;
      record.tracked.github_evidence_warnings = published.warnings;
      delete record.tracked.github_evidence_last_error;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_evidence_published",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: published.warnings.length > 0 ? `${published.url ?? "evidence published"} (${published.warnings.length} warning${published.warnings.length === 1 ? "" : "s"})` : published.url
      });
    } catch (error) {
      const message = errorMessage(error);
      record.tracked.github_evidence_last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: "pull_request_evidence_failed",
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message
      });
    }
  }

  private async readEvidenceManifestForPublish(workspacePath: string, fileName: string): Promise<EvidenceManifest | null> {
    return await readEvidenceManifest(workspacePath, fileName);
  }

  private async ensureIssueReviewState(record: IssueDebugRecord, knownIssue: Issue | null, source: string, throwOnFailure: boolean): Promise<void> {
    const reviewState = this.options.getConfig().tracker.review_state;
    if (!reviewState) return;
    await this.ensureTrackedIssueState(record, knownIssue, reviewState, {
      source,
      throwOnFailure,
      trackedPrefix: "tracker_review",
      failedEvent: "issue_review_state_failed",
      reconciledEvent: "issue_review_state_reconciled",
      missingMessage: "Tracked issue could not be refreshed for review-state reconciliation"
    });
  }

  private async ensureIssueCompletionState(record: IssueDebugRecord, knownIssue: Issue | null, source: string, throwOnFailure: boolean): Promise<void> {
    const completionState = this.options.getConfig().github.merge.complete_state;
    if (!completionState) return;
    await this.ensureTrackedIssueState(record, knownIssue, completionState, {
      source,
      throwOnFailure,
      trackedPrefix: "tracker_completion",
      failedEvent: "issue_completion_state_failed",
      reconciledEvent: "issue_completion_state_reconciled",
      missingMessage: "Tracked issue could not be refreshed for completion-state reconciliation"
    });
  }

  private async ensureTrackedIssueState(
    record: IssueDebugRecord,
    knownIssue: Issue | null,
    targetState: string,
    options: {
      source: string;
      throwOnFailure: boolean;
      trackedPrefix: string;
      failedEvent: string;
      reconciledEvent: string;
      missingMessage: string;
    }
  ): Promise<void> {
    if (!this.options.tracker.transitionIssue) {
      const message = "Tracker does not support issue state transitions";
      record.last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: options.failedEvent,
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: `${options.source}: ${message}`
      });
      if (options.throwOnFailure) throw new Error(message);
      return;
    }

    let issue = knownIssue;
    if (!issue) {
      try {
        const refreshed = await this.options.tracker.fetchIssueStatesByIds([record.issue_id]);
        issue = refreshed[0] ?? null;
      } catch (error) {
        const message = errorMessage(error);
        record.last_error = message;
        this.recordEvent({
          at: new Date().toISOString(),
          event: options.failedEvent,
          issue_id: record.issue_id,
          issue_identifier: record.issue_identifier,
          message: `${options.source}: ${message}`
        });
        if (options.throwOnFailure) throw error;
        return;
      }
    }

    if (!issue) {
      const message = options.missingMessage;
      record.last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: options.failedEvent,
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: `${options.source}: ${message}`
      });
      if (options.throwOnFailure) throw new Error(message);
      return;
    }

    const checkedAt = new Date().toISOString();
    if (normalizeState(issue.state) === normalizeState(targetState)) {
      record.tracked[`${options.trackedPrefix}_state`] = issue.state;
      record.tracked[`${options.trackedPrefix}_state_checked_at`] = checkedAt;
      record.tracked[`${options.trackedPrefix}_state_source`] = options.source;
      record.last_error = null;
      return;
    }

    try {
      const updated = await this.options.tracker.transitionIssue(issue, targetState);
      record.tracked[`${options.trackedPrefix}_state`] = updated.state;
      record.tracked[`${options.trackedPrefix}_state_checked_at`] = checkedAt;
      record.tracked[`${options.trackedPrefix}_state_source`] = options.source;
      record.last_error = null;
      this.recordEvent({
        at: checkedAt,
        event: options.reconciledEvent,
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: `${options.source}: ${issue.state} -> ${updated.state}`
      });
    } catch (error) {
      const message = errorMessage(error);
      record.last_error = message;
      this.recordEvent({
        at: new Date().toISOString(),
        event: options.failedEvent,
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        message: `${options.source}: ${message}`
      });
      if (options.throwOnFailure) throw error;
    }
  }

  private scheduleRetry(issueId: string, attempt: number, identifier: string, error: string | null, continuation: boolean, context: string | null): void {
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
      error,
      context
    };
    this.state.retry_attempts.set(issueId, retry);
    this.state.claimed.add(issueId);
    this.persistState();
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);
    let candidates: Issue[];
    try {
      candidates = await this.options.tracker.fetchCandidateIssues();
    } catch {
      this.scheduleRetry(issueId, retry.attempt + 1, retry.identifier, "retry poll failed", false, retry.context);
      return;
    }
    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      this.state.completed.add(issueId);
      this.persistState();
      return;
    }
    if (!this.shouldDispatchIgnoringClaim(issue)) {
      this.scheduleRetry(issueId, retry.attempt + 1, issue.identifier, "no available orchestrator slots", false, retry.context);
      return;
    }
    this.state.claimed.delete(issueId);
    this.dispatchIssue(issue, retry.attempt, retry.context);
    this.persistState();
  }

  private shouldDispatchIgnoringClaim(issue: Issue): boolean {
    const wasClaimed = this.state.claimed.delete(issue.id);
    const ok = this.shouldDispatch(issue);
    if (wasClaimed) this.state.claimed.add(issue.id);
    return ok;
  }

  private markPullRequestFollowupHandled(record: IssueDebugRecord): void {
    const inflightKeys = readStringArray(record.tracked.github_pr_inflight_followup_keys);
    if (inflightKeys.length === 0) return;
    const handledKeys = new Set(readHandledPullRequestFollowupKeys(record));
    for (const key of inflightKeys) handledKeys.add(key);
    const values = [...handledKeys].sort();
    record.tracked.github_pr_handled_followup_keys = values;
    record.tracked.github_pr_followup_keys = values;
    delete record.tracked.github_pr_inflight_followup_keys;
  }

  private async terminateRunning(issueId: string, reason: string, cleanupWorkspace: boolean): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    await Promise.resolve(entry.terminate(reason));
    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);
    if (cleanupWorkspace) await this.options.workspaceManager.removeForIssue(entry.identifier);
    this.persistState();
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
      run_attempts: [],
      tracked: {}
    };
    this.state.issue_history.set(issue.identifier, record);
    return record;
  }

  private startRunAttempt(record: IssueDebugRecord, entry: RunningEntry, followupContext: string | null): void {
    record.run_attempts.push({
      attempt: entry.retry_attempt,
      status: "running",
      started_at: entry.started_at,
      finished_at: null,
      runtime_seconds: null,
      workspace_path: entry.workspace_path,
      session_id: null,
      turn_count: 0,
      error: null,
      followup: Boolean(followupContext)
    });
    this.trimIssueRecord(record);
  }

  private finishRunAttempt(
    record: IssueDebugRecord,
    entry: RunningEntry,
    result: { ok: boolean; runtime_seconds: number; error?: string; workspace_path?: string }
  ): void {
    const attempt = [...record.run_attempts].reverse().find((item) => item.status === "running" && item.started_at === entry.started_at);
    const updated: RunAttemptRecord = {
      attempt: entry.retry_attempt,
      status: result.ok ? "succeeded" : "failed",
      started_at: entry.started_at,
      finished_at: new Date().toISOString(),
      runtime_seconds: result.runtime_seconds,
      workspace_path: result.workspace_path ?? entry.workspace_path,
      session_id: entry.session_id,
      turn_count: entry.turn_count,
      error: result.error ?? null,
      followup: attempt?.followup ?? false
    };
    if (attempt) Object.assign(attempt, updated);
    else record.run_attempts.push(updated);
    this.trimIssueRecord(record);
  }

  private trimObservabilityState(config: SymphonyConfig = this.options.getConfig()): void {
    trimArray(this.state.recent_events, config.observability.recent_event_limit);
    for (const record of this.state.issue_history.values()) this.trimIssueRecord(record, config);
  }

  private trimIssueRecord(record: IssueDebugRecord, config: SymphonyConfig = this.options.getConfig()): IssueDebugRecord {
    trimArray(record.recent_events, config.observability.issue_event_limit);
    trimArray(record.run_attempts, config.observability.run_attempt_limit);
    return record;
  }

  private markInterruptedAttempts(record: IssueDebugRecord, restoredAt: string): IssueDebugRecord {
    for (const attempt of record.run_attempts) {
      if (attempt.status !== "running") continue;
      attempt.status = "failed";
      attempt.finished_at = attempt.finished_at ?? restoredAt;
      attempt.error = attempt.error ?? "orchestrator restarted before worker completion";
    }
    return record;
  }

  private recordEvent(event: RuntimeEvent): void {
    const config = this.options.getConfig();
    this.state.recent_events.push(event);
    trimArray(this.state.recent_events, config.observability.recent_event_limit);
    if (event.issue_identifier) {
      const record = this.state.issue_history.get(event.issue_identifier);
      if (record) {
        record.recent_events.push(event);
        this.trimIssueRecord(record, config);
      }
    }
    this.options.logger.info(event.event, {
      issue_id: event.issue_id,
      issue_identifier: event.issue_identifier,
      session_id: event.session_id,
      message: event.message
    });
    this.persistState();
  }

  private persistState(): void {
    const store = this.options.durableStore;
    if (!store) return;
    const snapshot = this.durableSnapshot();
    this.persistenceChain = this.persistenceChain
      .catch(() => undefined)
      .then(() => store.save(snapshot))
      .catch((error: unknown) => {
        this.options.logger.warn("durable state save failed", { error: errorMessage(error) });
      });
  }

  private async flushPersistence(): Promise<void> {
    await this.persistenceChain.catch(() => undefined);
  }

  private durableSnapshot(): DurableStateSnapshot {
    const config = this.options.getConfig();
    this.trimObservabilityState(config);
    return {
      schema_version: 1,
      saved_at: new Date().toISOString(),
      retry_attempts: [...this.state.retry_attempts.values()].map((retry) => ({
        issue_id: retry.issue_id,
        identifier: retry.identifier,
        attempt: retry.attempt,
        due_at_ms: retry.due_at_ms,
        error: retry.error,
        context: retry.context
      })),
      completed_issue_ids: [...this.state.completed],
      issue_history: [...this.state.issue_history.values()],
      recent_events: this.state.recent_events.slice(-config.observability.recent_event_limit),
      codex_totals: this.state.codex_totals,
      codex_rate_limits: this.state.codex_rate_limits
    };
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

function trimArray<T>(values: T[], limit: number): void {
  if (values.length > limit) values.splice(0, values.length - limit);
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

async function readEvidenceManifest(workspacePath: string, fileName: string): Promise<EvidenceManifest | null> {
  try {
    const raw = await readFile(path.join(workspacePath, fileName), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new SymphonyError("invalid_evidence_manifest", `${fileName} must contain valid JSON`, error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SymphonyError("invalid_evidence_manifest", `${fileName} must be a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(Array.isArray(record.verification) ? { verification: record.verification.filter((entry): entry is string => typeof entry === "string") } : {}),
      ...(Array.isArray(record.commands) ? { commands: record.commands.map(readEvidenceCommand).filter((entry): entry is EvidenceCommand => Boolean(entry)) } : {}),
      ...(Array.isArray(record.app_urls) ? { app_urls: record.app_urls.filter((entry): entry is string => typeof entry === "string") } : {}),
      ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts.map(readEvidenceArtifact).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) } : {}),
      ...(typeof record.notes === "string" ? { notes: record.notes } : {})
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function readEvidenceCommand(value: unknown): EvidenceCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.trim().length === 0) return null;
  return {
    command: record.command,
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {})
  };
}

function readEvidenceArtifact(value: unknown): EvidenceArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {})
  };
}

function readTrackedPullRequest(value: unknown): PublishedPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const number = typeof record.number === "number" ? record.number : null;
  const url = typeof record.url === "string" ? record.url : null;
  const branch = typeof record.branch === "string" ? record.branch : null;
  const title = typeof record.title === "string" ? record.title : null;
  const created = typeof record.created === "boolean" ? record.created : false;
  if (!number || !url || !branch || !title) return null;
  return { number, url, branch, title, created };
}

function readTrackedEvidence(tracked: Record<string, unknown>): unknown {
  const commentUrl = typeof tracked.github_evidence_comment_url === "string" ? tracked.github_evidence_comment_url : null;
  const publishedAt = typeof tracked.github_evidence_published_at === "string" ? tracked.github_evidence_published_at : null;
  const lastError = typeof tracked.github_evidence_last_error === "string" ? tracked.github_evidence_last_error : null;
  const manifest = readTrackedEvidenceManifest(tracked.github_evidence_manifest);
  const warnings = readStringArray(tracked.github_evidence_warnings);
  if (!commentUrl && !publishedAt && !lastError && !manifest && warnings.length === 0) return null;
  return {
    comment_url: commentUrl,
    published_at: publishedAt,
    last_error: lastError,
    warnings,
    manifest
  };
}

function readTrackedEvidenceManifest(value: unknown): EvidenceManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(Array.isArray(record.verification) ? { verification: record.verification.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(Array.isArray(record.commands) ? { commands: record.commands.map(readEvidenceCommand).filter((entry): entry is EvidenceCommand => Boolean(entry)) } : {}),
    ...(Array.isArray(record.app_urls) ? { app_urls: record.app_urls.filter((entry): entry is string => typeof entry === "string") } : {}),
    ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts.map(readEvidenceArtifact).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)) } : {}),
    ...(typeof record.notes === "string" ? { notes: record.notes } : {})
  };
}

function pullRequestStatusKey(inspection: PullRequestInspection): string {
  return [inspection.state, inspection.checks_status, inspection.review_status, inspection.head_sha ?? "no-sha"].join(":");
}

type PullRequestFeedback = { key: string; reason: string };

function pullRequestFollowupFeedback(inspection: PullRequestInspection, handledKeys: Set<string>): PullRequestFeedback[] {
  const feedback: PullRequestFeedback[] = [];
  const failingChecks = actionableChecks(inspection);
  if (failingChecks.length > 0) {
    feedback.push({
      key: feedbackKey("checks", {
        head_sha: inspection.head_sha,
        checks: failingChecks.map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          details_url: check.details_url
        }))
      }),
      reason: "GitHub checks are failing"
    });
  }

  for (const review of actionableReviewsByReviewer(inspection, ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]).filter((review) => review.state === "CHANGES_REQUESTED")) {
    feedback.push({
      key: feedbackKey("review_changes", reviewIdentity(review)),
      reason: "GitHub review requested changes"
    });
  }

  for (const comment of inspection.issue_comments ?? []) {
    feedback.push({
      key: feedbackKey("issue_comment", {
        author: comment.author,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        url: comment.url,
        body: comment.body
      }),
      reason: "GitHub PR conversation comments need attention"
    });
  }
  for (const review of actionableReviewsByReviewer(inspection, ["COMMENTED"]).filter((review) => Boolean(review.body?.trim()))) {
    feedback.push({
      key: feedbackKey("review_comment", reviewIdentity(review)),
      reason: "GitHub review comments need attention"
    });
  }
  const unresolvedThreads = actionableReviewThreads(inspection);
  if (unresolvedThreads.length > 0) {
    for (const thread of unresolvedThreads) {
      feedback.push({
        key: feedbackKey("review_thread", {
          id: thread.id,
          comments: thread.comments.map((comment) => ({
            author: comment.author,
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            url: comment.url,
            body: comment.body
          }))
        }),
        reason: "GitHub unresolved review threads need attention"
      });
    }
  } else if ((inspection.review_threads ?? []).length === 0) {
    for (const comment of actionableReviewComments(inspection)) {
      feedback.push({
        key: feedbackKey("inline_comment", {
          author: comment.author,
          path: comment.path,
          line: comment.line,
          created_at: comment.created_at,
          updated_at: comment.updated_at,
          url: comment.url,
          body: comment.body
        }),
        reason: "GitHub inline review comments need attention"
      });
    }
  }

  const seen = new Set<string>();
  return feedback.filter((item) => {
    if (seen.has(item.key) || handledKeys.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function readHandledPullRequestFollowupKeys(record: IssueDebugRecord): Set<string> {
  return new Set(readStringArray(record.tracked.github_pr_handled_followup_keys));
}

function isManagedPullRequestBranch(pullRequest: PublishedPullRequest, config: SymphonyConfig): boolean {
  const branchPrefix = `${config.github.branch_prefix.replace(/\/+$/g, "")}/`;
  return pullRequest.branch.startsWith(branchPrefix);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeMergeableState(state: string | null): string | null {
  return state ? state.toLowerCase() : null;
}

function actionableChecks(inspection: PullRequestInspection): PullRequestInspection["checks"] {
  if (inspection.checks_status !== "failure") return [];
  return inspection.checks.filter((check) => {
    const conclusion = check.conclusion?.toLowerCase() ?? "";
    return ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(conclusion);
  });
}

function actionableReviewsByReviewer(inspection: PullRequestInspection, states: string[]): PullRequestInspection["reviews"] {
  return latestReviewsByReviewer(inspection.reviews, states).filter((review) => isCurrentHeadFeedback(review.commit_id, inspection.head_sha));
}

function actionableReviewComments(inspection: PullRequestInspection): PullRequestInspection["review_comments"] {
  return (inspection.review_comments ?? []).filter((comment) => isCurrentHeadFeedback(comment.commit_id, inspection.head_sha));
}

function actionableReviewThreads(inspection: PullRequestInspection): PullRequestInspection["review_threads"] {
  return (inspection.review_threads ?? []).filter(
    (thread) =>
      !thread.is_resolved &&
      !thread.is_outdated &&
      thread.comments.some((comment) => comment.body.trim().length > 0) &&
      thread.comments.some((comment) => isCurrentHeadFeedback(comment.commit_id, inspection.head_sha))
  );
}

function isCurrentHeadFeedback(commitId: string | null | undefined, headSha: string | null): boolean {
  if (!commitId || !headSha) return true;
  return commitId === headSha;
}

function latestReviewsByReviewer(reviews: PullRequestInspection["reviews"], states: string[]): PullRequestInspection["reviews"] {
  const allowedStates = new Set(states);
  const latest = new Map<string, { review: PullRequestInspection["reviews"][number]; submittedAt: number }>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    if (!allowedStates.has(state)) continue;
    const submittedAt = review.submitted_at ? Date.parse(review.submitted_at) : 0;
    const existing = latest.get(review.reviewer);
    if (!existing || submittedAt >= existing.submittedAt) latest.set(review.reviewer, { review: { ...review, state }, submittedAt });
  }
  return [...latest.values()].map((entry) => entry.review);
}

function reviewIdentity(review: PullRequestInspection["reviews"][number]): Record<string, unknown> {
  return {
    reviewer: review.reviewer,
    state: review.state,
    submitted_at: review.submitted_at,
    url: review.url,
    body: review.body
  };
}

function feedbackKey(prefix: string, value: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
  return `${prefix}:${hash}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function renderPullRequestFollowupContext(
  record: IssueDebugRecord,
  pullRequest: PublishedPullRequest,
  inspection: PullRequestInspection,
  reason: string,
  prReadyFile: string
): string {
  const lines = [
    `Issue: ${record.issue_identifier}`,
    `Pull request: ${pullRequest.url}`,
    `Reason: ${reason}.`,
    `Status: ${inspection.summary}`,
    `Branch: ${inspection.branch}`,
    `Head SHA: ${inspection.head_sha ?? "unknown"}`,
    "",
    "Worker task:",
    "- Inspect the existing workspace and branch.",
    "- Fix the PR feedback or failing verification.",
    "- Commit the follow-up changes.",
    `- Update ${prReadyFile} so Symphony can update the existing PR.`
  ];
  const failingChecks = actionableChecks(inspection);
  if (failingChecks.length > 0) {
    lines.push("", "Check details:");
    for (const check of failingChecks.slice(0, 10)) {
      const state = [check.status, check.conclusion].filter(Boolean).join("/");
      lines.push(`- ${check.name}: ${state || "unknown"}${check.details_url ? ` (${check.details_url})` : ""}`);
    }
  }
  const reviewSummaries = [
    ...actionableReviewsByReviewer(inspection, ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]).filter((review) => review.state === "CHANGES_REQUESTED"),
    ...actionableReviewsByReviewer(inspection, ["COMMENTED"]).filter((review) => Boolean(review.body?.trim()))
  ];
  if (reviewSummaries.length > 0) {
    lines.push("", "Review summaries:");
    for (const review of reviewSummaries.slice(0, 10)) {
      lines.push(`- ${review.reviewer} ${review.state}${review.submitted_at ? ` at ${review.submitted_at}` : ""}: ${singleLine(review.body ?? "Changes requested.")}`);
    }
  }
  if ((inspection.issue_comments ?? []).length > 0) {
    lines.push("", "PR conversation comments:");
    for (const comment of (inspection.issue_comments ?? []).slice(0, 20)) {
      lines.push(`- ${comment.author}${comment.updated_at ? ` at ${comment.updated_at}` : ""}: ${singleLine(comment.body)}${comment.url ? ` (${comment.url})` : ""}`);
    }
  }
  const unresolvedThreads = actionableReviewThreads(inspection);
  if (unresolvedThreads.length > 0) {
    lines.push("", "Unresolved review threads:");
    for (const thread of unresolvedThreads.slice(0, 20)) {
      const location = [thread.path, thread.line ? `line ${thread.line}` : null].filter(Boolean).join(":");
      const latest = thread.comments.at(-1);
      lines.push(
        `- ${location || "unknown location"}${thread.is_outdated ? " (outdated)" : ""}: ${latest ? `${latest.author}: ${singleLine(latest.body)}${latest.url ? ` (${latest.url})` : ""}` : "No comment text."}`
      );
    }
  } else if (actionableReviewComments(inspection).length > 0) {
    lines.push("", "Inline review comments:");
    for (const comment of actionableReviewComments(inspection).slice(0, 20)) {
      const location = [comment.path, comment.line ? `line ${comment.line}` : null].filter(Boolean).join(":");
      lines.push(`- ${location || "unknown location"} by ${comment.author}: ${singleLine(comment.body)}${comment.url ? ` (${comment.url})` : ""}`);
    }
  }
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function summarizeRaw(raw: unknown): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(raw).slice(0, 500);
  } catch {
    return String(raw).slice(0, 500);
  }
}

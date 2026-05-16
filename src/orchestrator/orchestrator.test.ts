import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type {
  DiscoveredPullRequest,
  DurableStateSnapshot,
  DurableStateStore,
  PullRequestInspection,
  PullRequestEvidencePublisher,
  PullRequestMerger,
  PullRequestPublisher,
  PullRequestTracker,
  SymphonyConfig
} from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { FakeTracker, issue } from "../testing/fakes.js";
import { LocalTracker } from "../testing/localTracker.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { Orchestrator, sortForDispatch } from "./orchestrator.js";

describe("orchestrator", () => {
  test("sorts dispatch by priority, created_at, and identifier", () => {
    const sorted = sortForDispatch([
      issue({ identifier: "B", priority: null, created_at: "2026-01-01T00:00:00.000Z" }),
      issue({ identifier: "C", priority: 2, created_at: "2026-01-03T00:00:00.000Z" }),
      issue({ identifier: "A", priority: 1, created_at: "2026-01-02T00:00:00.000Z" }),
      issue({ identifier: "D", priority: 1, created_at: "2026-01-01T00:00:00.000Z" })
    ]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["D", "A", "C", "B"]);
  });

  test("dispatches eligible issues, records token totals, and schedules continuation retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const serverPath = path.join(root, "fake-codex.mjs");
    await writeFile(serverPath, fakeCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = config(root, `node ${serverPath}`);
    const activeIssue = issue({ id: "i-1", identifier: "ABC-1", state: "Todo" });
    const tracker = new FakeTracker([activeIssue], [], [issue({ id: "i-1", identifier: "ABC-1", state: "Human Review" })]);
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      logger: createLogger(() => undefined)
    });
    await orchestrator.tick();
    await waitFor(() => (orchestrator.snapshot() as { counts: { retrying: number } }).counts.retrying === 1, "continuation retry");
    const snapshot = orchestrator.snapshot() as {
      counts: { retrying: number };
      codex_totals: { total_tokens: number };
      rate_limits: unknown;
      recent_events: Array<{ event: string; issue_identifier?: string; message?: string | null }>;
    };
    expect(snapshot.counts.retrying).toBe(1);
    expect(snapshot.codex_totals.total_tokens).toBe(7);
    expect(snapshot.rate_limits).toEqual({ primary: { used: 1, limit: 100 } });
    expect(snapshot.recent_events.some((event) => event.event === "dispatch" && event.issue_identifier === "ABC-1")).toBe(true);
    expect(snapshot.recent_events.some((event) => event.event === "turn/completed" && event.issue_identifier === "ABC-1")).toBe(true);
    expect(orchestrator.issueSnapshot("ABC-1")).toMatchObject({
      attempts: {
        run_attempts: [
          {
            attempt: null,
            status: "succeeded",
            workspace_path: manager.workspacePath("ABC-1"),
            turn_count: 1,
            error: null,
            followup: false
          }
        ]
      }
    });
    await orchestrator.stop();
  });

  test("blocked Todo issue is not dispatched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const cfg = config(root, "node missing.js");
    const blocked = issue({ blocked_by: [{ id: "b", identifier: "ABC-0", state: "Todo" }] });
    const tracker = new FakeTracker([blocked], [], []);
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "body", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      logger: createLogger(() => undefined)
    });
    await orchestrator.tick();
    expect((orchestrator.snapshot() as { counts: { running: number } }).counts.running).toBe(0);
    await orchestrator.stop();
  });

  test("trims observability history using workflow limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-observe-"));
    const cfg = {
      ...config(root, "node missing.js"),
      observability: { recent_event_limit: 2, issue_event_limit: 1, run_attempt_limit: 1 }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "body", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker: new FakeTracker([], [], []),
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      logger: createLogger(() => undefined)
    });
    orchestrator.state.recent_events.push(
      { at: "2026-01-01T00:00:00.000Z", event: "one", issue_identifier: "SAM-80" },
      { at: "2026-01-01T00:00:01.000Z", event: "two", issue_identifier: "SAM-80" },
      { at: "2026-01-01T00:00:02.000Z", event: "three", issue_identifier: "SAM-80" }
    );
    orchestrator.state.issue_history.set("SAM-80", {
      issue_id: "i-observe",
      issue_identifier: "SAM-80",
      workspace_path: null,
      restart_count: 0,
      last_error: null,
      run_attempts: [
        {
          attempt: null,
          status: "succeeded",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:01.000Z",
          runtime_seconds: 1,
          workspace_path: "/tmp/old",
          session_id: "old-session",
          turn_count: 1,
          error: null,
          followup: false
        },
        {
          attempt: 1,
          status: "failed",
          started_at: "2026-01-01T00:00:02.000Z",
          finished_at: "2026-01-01T00:00:03.000Z",
          runtime_seconds: 1,
          workspace_path: "/tmp/new",
          session_id: "new-session",
          turn_count: 2,
          error: "failed",
          followup: true
        }
      ],
      recent_events: [
        { at: "2026-01-01T00:00:01.000Z", event: "issue-two", issue_identifier: "SAM-80" },
        { at: "2026-01-01T00:00:02.000Z", event: "issue-three", issue_identifier: "SAM-80" }
      ],
      tracked: {}
    });

    orchestrator.notifyConfigReload(cfg);

    expect((orchestrator.snapshot() as { recent_events: Array<{ event: string }> }).recent_events.map((event) => event.event)).toEqual(["two", "three"]);
    expect(orchestrator.issueSnapshot("SAM-80")).toMatchObject({
      attempts: { run_attempts: [{ attempt: 1, status: "failed", session_id: "new-session" }] },
      recent_events: [{ event: "issue-three" }]
    });
  });

  test("claims an issue, publishes PR-ready worker commits, comments, and moves to review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr", identifier: "SAM-9", state: "Todo", title: "Ship PR loop" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9-ship-pr-loop", title: "SAM-9: Ship PR loop", created: true };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "pull request publication");

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      issue: { identifier: "SAM-9", state: "In Progress" },
      manifest: { title: "SAM-9: Ship PR loop", verification: ["pnpm test"] }
    });
    expect(tracker.getIssue("i-pr")?.state).toBe("Needs Human");
    expect(tracker.comments[0]?.body).toContain("https://github.test/acme/widgets/pull/9");
    expect(orchestrator.issueSnapshot("SAM-9")).toMatchObject({
      status: "completed",
      attempts: {
        run_attempts: [
          {
            status: "succeeded",
            turn_count: 1,
            followup: false
          }
        ]
      },
      tracked: { github_pull_request: { url: "https://github.test/acme/widgets/pull/9" } }
    });
    await tracker.transitionIssue(activeIssue, "In Progress");
    await orchestrator.tick();
    expect(published).toHaveLength(1);
    await orchestrator.stop();
  });

  test("publishes worker evidence manifest back to the pull request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-evidence-"));
    const serverPath = path.join(root, "fake-codex-evidence.mjs");
    await writeFile(serverPath, fakePrReadyWithEvidenceCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-evidence", identifier: "SAM-18", state: "Todo", title: "Publish evidence" });
    const tracker = new LocalTracker([activeIssue]);
    const prPublishInputs: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        prPublishInputs.push(input);
        return { number: 18, url: "https://github.test/acme/widgets/pull/18", branch: "symphony/sam-18-publish-evidence", title: "SAM-18: Publish evidence", created: true };
      }
    };
    const evidencePublished: unknown[] = [];
    const evidencePublisher: PullRequestEvidencePublisher = {
      async publish(input) {
        evidencePublished.push(input);
        return { comment_id: 1818, url: "https://github.test/acme/widgets/pull/18#issuecomment-1818", warnings: ["Artifact path is not tracked by git at publish time"] };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestEvidencePublisher: evidencePublisher,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => evidencePublished.length === 1, "pull request evidence publication");

    expect(evidencePublished[0]).toMatchObject({
      pullRequest: { number: 18 },
      manifest: {
        summary: "Verified with Playwright.",
        verification: ["pnpm test", "npx playwright test"],
        app_urls: ["http://127.0.0.1:3000"],
        artifacts: [{ kind: "screenshot", path: "artifacts/SAM-18/home.png" }]
      }
    });
    expect(prPublishInputs[0]).toMatchObject({
      evidenceManifest: {
        artifacts: [{ kind: "screenshot", path: "artifacts/SAM-18/home.png" }]
      }
    });
    expect(orchestrator.issueSnapshot("SAM-18")).toMatchObject({
      tracked: {
        github_evidence_comment_id: 1818,
        github_evidence_comment_url: "https://github.test/acme/widgets/pull/18#issuecomment-1818",
        github_evidence_warnings: ["Artifact path is not tracked by git at publish time"],
        github_evidence_manifest: {
          artifacts: [{ kind: "screenshot", path: "artifacts/SAM-18/home.png" }]
        }
      }
    });
    expect(orchestrator.snapshot()).toMatchObject({
      pull_requests: [
        {
          issue_identifier: "SAM-18",
          evidence: {
            comment_url: "https://github.test/acme/widgets/pull/18#issuecomment-1818",
            warnings: ["Artifact path is not tracked by git at publish time"],
            manifest: {
              verification: ["pnpm test", "npx playwright test"],
              app_urls: ["http://127.0.0.1:3000"],
              artifacts: [{ kind: "screenshot", path: "artifacts/SAM-18/home.png" }]
            }
          }
        }
      ]
    });
    await orchestrator.stop();
  });

  test("clears stale durable last_error after successful PR publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-clear-error-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-clear-error", identifier: "SAM-15", state: "Todo", title: "Clear stale error" });
    const tracker = new LocalTracker([activeIssue]);
    const saved: DurableStateSnapshot[] = [];
    const durableStore: DurableStateStore = {
      async load() {
        return {
          schema_version: 1,
          saved_at: new Date().toISOString(),
          retry_attempts: [],
          completed_issue_ids: [],
          issue_history: [
            {
              issue_id: activeIssue.id,
              issue_identifier: activeIssue.identifier,
              workspace_path: null,
              restart_count: 0,
              last_error: "old push rejection",
              run_attempts: [],
              recent_events: [],
              tracked: {}
            }
          ],
          recent_events: [],
          codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
          codex_rate_limits: null
        };
      },
      async save(snapshot) {
        saved.push(snapshot);
      }
    };
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 15, url: "https://github.test/acme/widgets/pull/15", branch: "symphony/sam-15-clear-stale-error", title: "SAM-15: Clear stale error", created: true };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      durableStore,
      pullRequestPublisher: publisher,
      logger: createLogger(() => undefined)
    });

    await orchestrator.start();
    await waitFor(() => published.length === 1, "pull request publication after stale error");

    expect(orchestrator.issueSnapshot("SAM-15")).toMatchObject({
      status: "completed",
      last_error: null,
      tracked: { github_pull_request: { number: 15 } }
    });
    await orchestrator.stop();
    expect(saved.at(-1)?.issue_history.find((record) => record.issue_identifier === "SAM-15")?.last_error).toBeNull();
  });

  test("reconciles tracker review state for open PRs after external automation moves it back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-review-state-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-reconcile", identifier: "SAM-9", state: "Todo", title: "Ship PR loop" });
    const tracker = new LocalTracker([activeIssue]);
    const publisher: PullRequestPublisher = {
      async publish() {
        return { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9-ship-pr-loop", title: "SAM-9: Ship PR loop", created: true };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return {
          number: 9,
          url: "https://github.test/acme/widgets/pull/9",
          branch: "symphony/sam-9-ship-pr-loop",
          title: "SAM-9: Ship PR loop",
          state: "open",
          checks_status: "success",
          review_status: "review_required",
          head_sha: "abc123def456",
          mergeable_state: "clean",
          draft: false,
          checked_at: new Date().toISOString(),
          summary: "PR #9 is open; checks=success; review=review_required at abc123def456.",
          checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/9" }],
          reviews: [],
          review_comments: []
        };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => tracker.getIssue("i-pr-reconcile")?.state === "Needs Human", "initial review-state transition");
    await tracker.transitionIssue(activeIssue, "In Progress");

    await orchestrator.tick();

    expect(tracker.getIssue("i-pr-reconcile")?.state).toBe("Needs Human");
    expect(orchestrator.issueSnapshot("SAM-9")).toMatchObject({
      tracked: { tracker_review_state: "Needs Human", tracker_review_state_source: "pull_request_reconcile" }
    });
    await orchestrator.stop();
  });

  test("merges approved passing PRs and moves the tracker issue to completion state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-merge-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human",
        terminal_states: ["Done"]
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token",
        merge: { ...githubMergeDisabled(), enabled: true, complete_state: "Done" }
      }
    };
    const activeIssue = issue({ id: "i-pr-merge", identifier: "SAM-16", state: "Todo", title: "Merge approved PR" });
    const tracker = new LocalTracker([activeIssue]);
    const publisher: PullRequestPublisher = {
      async publish() {
        return { number: 16, url: "https://github.test/acme/widgets/pull/16", branch: "symphony/sam-16-merge-approved-pr", title: "SAM-16: Merge approved PR", created: true };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return approvedInspection();
      }
    };
    const merged: unknown[] = [];
    const pullRequestMerger: PullRequestMerger = {
      async merge(input) {
        merged.push(input);
        return { number: input.pullRequest.number, url: input.pullRequest.url, merged: true, sha: "merge-sha", message: "merged" };
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      pullRequestMerger,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => tracker.getIssue("i-pr-merge")?.state === "Needs Human", "initial review-state transition");
    await orchestrator.tick();
    await waitFor(() => merged.length === 1, "approved pull request merge");

    expect(tracker.getIssue("i-pr-merge")?.state).toBe("Done");
    expect(merged[0]).toMatchObject({
      pullRequest: { number: 16 },
      inspection: { checks_status: "success", review_status: "approved", mergeable_state: "clean" }
    });
    expect(orchestrator.issueSnapshot("SAM-16")).toMatchObject({
      status: "completed",
      last_error: null,
      tracked: {
        github_pr_terminal_state: "merged",
        github_pull_request_merge: { merged: true, sha: "merge-sha" },
        tracker_completion_state: "Done",
        tracker_completion_state_source: "pull_request_merge"
      }
    });
    await orchestrator.stop();
  });

  test("does not merge PRs that have not satisfied the configured policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-merge-wait-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token",
        merge: { ...githubMergeDisabled(), enabled: true, complete_state: "Done" }
      }
    };
    const activeIssue = issue({ id: "i-pr-merge-wait", identifier: "SAM-17", state: "Todo", title: "Wait for merge policy" });
    const tracker = new LocalTracker([activeIssue]);
    const publisher: PullRequestPublisher = {
      async publish() {
        return { number: 17, url: "https://github.test/acme/widgets/pull/17", branch: "symphony/sam-17-wait-for-merge-policy", title: "SAM-17: Wait for merge policy", created: true };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return {
          ...approvedInspection(),
          number: 17,
          url: "https://github.test/acme/widgets/pull/17",
          branch: "symphony/sam-17-wait-for-merge-policy",
          title: "SAM-17: Wait for merge policy",
          checks_status: "pending",
          summary: "PR #17 is open; checks=pending; review=approved at merge-head-sha."
        };
      }
    };
    const pullRequestMerger: PullRequestMerger = {
      async merge() {
        throw new Error("merge should not be attempted");
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      pullRequestMerger,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => tracker.getIssue("i-pr-merge-wait")?.state === "Needs Human", "initial review-state transition");
    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(tracker.getIssue("i-pr-merge-wait")?.state).toBe("Needs Human");
    expect(orchestrator.issueSnapshot("SAM-17")).toMatchObject({
      status: "completed",
      tracked: { github_pull_request_status: { checks_status: "pending", review_status: "approved" } }
    });
    await orchestrator.stop();
  });

  test("requeues worker follow-up when a published PR has failing checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-followup-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-followup", identifier: "SAM-10", state: "Todo", title: "Close PR loop" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 10, url: "https://github.test/acme/widgets/pull/10", branch: "symphony/sam-10-close-pr-loop", title: "SAM-10: Close PR loop", created: published.length === 1 };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return failingInspection();
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "pull request follow-up publication");

    expect(tracker.getIssue("i-pr-followup")?.state).toBe("Needs Human");
    expect(tracker.comments.some((comment) => comment.body.includes("PR follow-up queued") && comment.body.includes("verify"))).toBe(true);
    const promptLog = await readFile(path.join(manager.workspacePath("SAM-10"), "prompts.log"), "utf8");
    expect(promptLog).toContain("Orchestrator follow-up context");
    expect(promptLog).toContain("GitHub checks are failing");
    expect(promptLog).toContain("verify");
    expect(orchestrator.issueSnapshot("SAM-10")).toMatchObject({
      tracked: { github_pull_request_status: { checks_status: "failure" } }
    });
    await orchestrator.stop();
  });

  test("does not requeue stale changes-requested reviews after a worker follow-up push", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-stale-review-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-stale-review", identifier: "SAM-13", state: "Todo", title: "Handle stale review" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 13, url: "https://github.test/acme/widgets/pull/13", branch: "symphony/sam-13-handle-stale-review", title: "SAM-13: Handle stale review", created: published.length === 1 };
      }
    };
    let inspectCount = 0;
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        inspectCount += 1;
        return changesRequestedInspection(inspectCount === 1 ? "old-head-sha" : "new-head-sha");
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "review follow-up publication");
    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(published).toHaveLength(2);
    expect(tracker.getIssue("i-pr-stale-review")?.state).toBe("Needs Human");
    expect(orchestrator.issueSnapshot("SAM-13")).toMatchObject({
      tracked: {
        github_pull_request_status: { review_status: "changes_requested" },
        github_pr_followup_reason: "GitHub review requested changes"
      }
    });
    await orchestrator.stop();
  });

  test("requeues comment-only PR review feedback and includes comments in worker context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-comments-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-comment-review", identifier: "SAM-14", state: "Todo", title: "Handle comment review" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 14, url: "https://github.test/acme/widgets/pull/14", branch: "symphony/sam-14-handle-comment-review", title: "SAM-14: Handle comment review", created: published.length === 1 };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return commentOnlyInspection();
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "comment follow-up publication");

    expect(tracker.comments.some((comment) => comment.body.includes("GitHub review comments need attention"))).toBe(true);
    const promptLog = await readFile(path.join(manager.workspacePath("SAM-14"), "prompts.log"), "utf8");
    expect(promptLog).toContain("GitHub review comments need attention");
    expect(promptLog).toContain("Please document the review-feedback loop.");
    expect(promptLog).toContain("src/orchestrator/orchestrator.ts:line 42");
    await orchestrator.stop();
  });

  test("requeues top-level PR comments and unresolved review threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-thread-comments-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-thread-comment", identifier: "SAM-19", state: "Todo", title: "Handle PR comments" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return { number: 19, url: "https://github.test/acme/widgets/pull/19", branch: "symphony/sam-19-handle-pr-comments", title: "SAM-19: Handle PR comments", created: published.length === 1 };
      }
    };
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        return conversationAndThreadInspection();
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "conversation and thread follow-up publication");

    expect(tracker.comments.some((comment) => comment.body.includes("GitHub PR conversation comments need attention") && comment.body.includes("GitHub unresolved review threads need attention"))).toBe(true);
    const promptLog = await readFile(path.join(manager.workspacePath("SAM-19"), "prompts.log"), "utf8");
    expect(promptLog).toContain("PR conversation comments");
    expect(promptLog).toContain("Please add a screenshot before review.");
    expect(promptLog).toContain("Unresolved review threads");
    expect(promptLog).toContain("src/widget.ts:line 88");
    await orchestrator.stop();
  });

  test("does not requeue an already handled review thread when GitHub moves the thread commit to the new head", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-thread-stable-"));
    const serverPath = path.join(root, "fake-codex-ready.mjs");
    await writeFile(serverPath, fakePrReadyCodexServerSource());
    await chmod(serverPath, 0o755);
    const cfg = {
      ...config(root, `node ${serverPath}`),
      tracker: {
        ...config(root, `node ${serverPath}`).tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-thread-stable", identifier: "SAM-20", state: "Todo", title: "Handle moving review thread" });
    const tracker = new LocalTracker([activeIssue]);
    const published: unknown[] = [];
    const publisher: PullRequestPublisher = {
      async publish(input) {
        published.push(input);
        return {
          number: 20,
          url: "https://github.test/acme/widgets/pull/20",
          branch: "symphony/sam-20-handle-moving-review-thread",
          title: "SAM-20: Handle moving review thread",
          created: published.length === 1
        };
      }
    };
    let inspectCount = 0;
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        inspectCount += 1;
        return movingReviewThreadInspection(inspectCount === 1 ? "old-head-sha" : "new-head-sha");
      }
    };
    const manager = new WorkspaceManager(() => cfg, createLogger(() => undefined));
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }} attempt={{ attempt }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: manager,
      pullRequestPublisher: publisher,
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();
    await waitFor(() => published.length === 1, "initial pull request publication");
    await orchestrator.tick();
    await waitFor(() => published.length === 2, "review thread follow-up publication");
    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(published).toHaveLength(2);
    expect(tracker.comments.filter((comment) => comment.body.includes("GitHub unresolved review threads need attention"))).toHaveLength(1);
    await orchestrator.stop();
  });

  test("recovers open Symphony PRs after restart and suppresses duplicate dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-recover-"));
    const cfg = {
      ...config(root, "node missing.js"),
      tracker: {
        ...config(root, "node missing.js").tracker,
        claim_state: "In Progress",
        review_state: "Needs Human"
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token"
      }
    };
    const activeIssue = issue({ id: "i-pr-recover", identifier: "SAM-11", state: "Todo", title: "Recovered PR should not redispatch" });
    const tracker = new LocalTracker([activeIssue]);
    const pullRequestTracker: PullRequestTracker = {
      async discoverOpen() {
        return [discoveredPullRequest()];
      },
      async inspect() {
        return healthyInspection();
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();

    const snapshot = orchestrator.snapshot() as { counts: { running: number; completed: number; pull_requests: number } };
    expect(snapshot.counts).toMatchObject({ running: 0, completed: 1, pull_requests: 1 });
    expect(orchestrator.issueSnapshot("SAM-11")).toMatchObject({
      status: "completed",
      tracked: {
        github_pr_recovered: true,
        github_pull_request: { number: 11, url: "https://github.test/acme/widgets/pull/11" },
        github_pull_request_status: { checks_status: "success" }
      }
    });
    await orchestrator.stop();
  });

  test("recovers human-merged Symphony PRs after restart and moves tracker issue to completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-recover-merged-"));
    const cfg = {
      ...config(root, "node missing.js"),
      tracker: {
        ...config(root, "node missing.js").tracker,
        claim_state: "In Progress",
        review_state: "Needs Human",
        terminal_states: ["Done"]
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token",
        merge: { ...githubMergeDisabled(), enabled: false, complete_state: "Done" }
      }
    };
    const reviewIssue = issue({ id: "i-pr-recover-merged", identifier: "SAM-22", state: "Needs Human", title: "Merged while offline" });
    const tracker = new LocalTracker([reviewIssue]);
    const discoveredStates: unknown[] = [];
    const pullRequestTracker: PullRequestTracker = {
      async discoverManaged(options) {
        discoveredStates.push(options?.states);
        return [mergedDiscoveredPullRequest()];
      },
      async inspect() {
        return mergedInspection();
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.tick();

    expect(discoveredStates).toEqual([["open", "closed"]]);
    expect(tracker.getIssue("i-pr-recover-merged")?.state).toBe("Done");
    expect(orchestrator.issueSnapshot("SAM-22")).toMatchObject({
      status: "completed",
      tracked: {
        github_pr_recovered: true,
        github_pr_terminal_state: "merged",
        tracker_completion_state: "Done",
        tracker_completion_state_source: "pull_request_reconcile"
      }
    });
    await orchestrator.stop();
  });

  test("reconcileOnce runs PR lifecycle reconciliation without dispatching candidate work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-reconcile-once-"));
    const cfg = {
      ...config(root, "node missing.js"),
      tracker: {
        ...config(root, "node missing.js").tracker,
        claim_state: "In Progress",
        review_state: "Needs Human",
        terminal_states: ["Done"]
      },
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token",
        merge: { ...githubMergeDisabled(), enabled: false, complete_state: "Done" }
      }
    };
    const reviewIssue = issue({ id: "i-pr-reconcile-once", identifier: "SAM-22", state: "Needs Human", title: "Merged while offline" });
    const readyIssue = issue({ id: "i-ready-reconcile-once", identifier: "SAM-23", state: "Todo", title: "Should not dispatch" });
    const tracker = new LocalTracker([reviewIssue, readyIssue]);
    const pullRequestTracker: PullRequestTracker = {
      async discoverManaged() {
        return [mergedDiscoveredPullRequest()];
      },
      async inspect() {
        return mergedInspection();
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });

    await orchestrator.start({ schedule: false });
    await orchestrator.reconcileOnce();

    expect(tracker.getIssue("i-pr-reconcile-once")?.state).toBe("Done");
    expect(tracker.getIssue("i-ready-reconcile-once")?.state).toBe("Todo");
    expect(orchestrator.snapshot()).toMatchObject({
      counts: { running: 0, retrying: 0 }
    });
    await orchestrator.stop();
  });

  test("ignores restored PR tracking outside the current branch prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-pr-prefix-"));
    const cfg = {
      ...config(root, "node missing.js"),
      github: {
        ...githubDisabled(),
        enabled: true,
        owner: "acme",
        repo: "widgets",
        token: "github-token",
        branch_prefix: "symphony-test"
      }
    };
    const tracker = new LocalTracker([issue({ id: "i-pr-prefix", identifier: "SAM-21", state: "Needs Human", title: "Old managed PR" })]);
    let inspected = 0;
    const pullRequestTracker: PullRequestTracker = {
      async inspect() {
        inspected += 1;
        return healthyInspection();
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      pullRequestTracker,
      logger: createLogger(() => undefined)
    });
    orchestrator.state.completed.add("i-pr-prefix");
    orchestrator.state.issue_history.set("SAM-21", {
      issue_id: "i-pr-prefix",
      issue_identifier: "SAM-21",
      workspace_path: null,
      restart_count: 0,
      last_error: null,
      run_attempts: [],
      recent_events: [],
      tracked: {
        github_pull_request: {
          number: 21,
          url: "https://github.test/acme/widgets/pull/21",
          branch: "symphony/sam-21-old-managed-pr",
          title: "SAM-21: Old managed PR",
          created: false
        }
      }
    });

    await orchestrator.tick();

    expect(inspected).toBe(0);
    expect(orchestrator.snapshot()).toMatchObject({ counts: { retrying: 0, pull_requests: 1 } });
    await orchestrator.stop();
  });

  test("restores durable retry queue and issue history on startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-durable-"));
    const cfg = config(root, "node missing.js");
    const saved: DurableStateSnapshot[] = [];
    const durableStore: DurableStateStore = {
      async load() {
        return durableSnapshot(Date.now() + 60_000);
      },
      async save(snapshot) {
        saved.push(snapshot);
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker: new FakeTracker([], [], []),
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      durableStore,
      logger: createLogger(() => undefined)
    });

    await orchestrator.start();

    expect(orchestrator.snapshot()).toMatchObject({
      counts: { retrying: 1, completed: 1 },
      retrying: [{ issue_id: "retry-1", issue_identifier: "SAM-12", attempt: 2, context: "Fix failing checks" }]
    });
    expect(orchestrator.issueSnapshot("SAM-12")).toMatchObject({
      status: "retrying",
      last_error: "verify failed",
      attempts: {
        run_attempts: [
          {
            status: "failed",
            error: "orchestrator restarted before worker completion"
          }
        ]
      },
      tracked: { github_pull_request: { number: 12 } }
    });
    await orchestrator.stop();
    expect(saved.at(-1)).toMatchObject({
      retry_attempts: [{ issue_id: "retry-1", identifier: "SAM-12", attempt: 2, context: "Fix failing checks" }],
      completed_issue_ids: ["done-1"]
    });
  });

  test("requeues due retries when worker slots are exhausted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-retry-slots-"));
    const serverPath = path.join(root, "fake-codex-long-running.mjs");
    await writeFile(serverPath, fakeLongRunningCodexServerSource());
    await chmod(serverPath, 0o755);
    const baseConfig = config(root, `node ${serverPath}`);
    const cfg = {
      ...baseConfig,
      agent: { ...baseConfig.agent, max_concurrent_agents: 1, max_retry_backoff_ms: 1000 }
    };
    const retryIssue = issue({ id: "retry-slot", identifier: "SAM-30", state: "Todo", title: "Retry when full", created_at: "2026-01-02T00:00:00.000Z" });
    const runningIssue = issue({ id: "running-slot", identifier: "SAM-31", state: "Todo", title: "Occupy slot", created_at: "2026-01-01T00:00:00.000Z" });
    const tracker = new FakeTracker([runningIssue, retryIssue], [], []);
    const durableStore: DurableStateStore = {
      async load() {
        return {
          schema_version: 1,
          saved_at: new Date().toISOString(),
          retry_attempts: [
            {
              issue_id: retryIssue.id,
              identifier: retryIssue.identifier,
              attempt: 2,
              due_at_ms: Date.now() + 150,
              error: "previous failure",
              context: "continue work"
            }
          ],
          completed_issue_ids: [],
          issue_history: [],
          recent_events: [],
          codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
          codex_rate_limits: null
        };
      },
      async save() {
        return undefined;
      }
    };
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({ config: {}, prompt_template: "Do {{ issue.identifier }}", path: path.join(root, "WORKFLOW.md"), loaded_at: new Date().toISOString() }),
      validateDispatch: async () => undefined,
      tracker,
      workspaceManager: new WorkspaceManager(() => cfg, createLogger(() => undefined)),
      durableStore,
      logger: createLogger(() => undefined)
    });

    await orchestrator.start();
    await waitFor(() => (orchestrator.snapshot() as { counts: { running: number } }).counts.running === 1, "slot occupant dispatch");
    await waitFor(
      () =>
        ((orchestrator.snapshot() as { retrying: Array<{ issue_identifier: string; attempt: number }> }).retrying.find((retry) => retry.issue_identifier === "SAM-30")
          ?.attempt ?? 0) === 3,
      "retry requeue after slot exhaustion"
    );

    expect(orchestrator.snapshot()).toMatchObject({
      counts: { running: 1, retrying: 1 },
      retrying: [{ issue_identifier: "SAM-30", attempt: 3, error: "no available orchestrator slots", context: "continue work" }]
    });
    await orchestrator.stop();
  });
});

function config(root: string, command: string): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "secret",
      project_slug: "demo",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 60_000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 2000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
    server: { port: null, host: "127.0.0.1" }
  };
}

function fakePrReadyCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    const text = msg.params?.input?.[0]?.text ?? "";
    appendFileSync("prompts.log", text + "\\n---\\n");
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    setTimeout(() => {
      writeFileSync("SYMPHONY_PR_READY.json", JSON.stringify({ title: "SAM-9: Ship PR loop", summary: "Done", verification: ["pnpm test"], risk: "Low" }));
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 10);
  }
});
`;
}

function fakePrReadyWithEvidenceCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    setTimeout(() => {
      mkdirSync("artifacts/SAM-18", { recursive: true });
      writeFileSync("artifacts/SAM-18/home.png", "fake image");
      writeFileSync("SYMPHONY_PR_READY.json", JSON.stringify({ title: "SAM-18: Publish evidence", summary: "Done", verification: ["pnpm test"], risk: "Low" }));
      writeFileSync("SYMPHONY_EVIDENCE.json", JSON.stringify({
        summary: "Verified with Playwright.",
        verification: ["pnpm test", "npx playwright test"],
        app_urls: ["http://127.0.0.1:3000"],
        artifacts: [{ kind: "screenshot", path: "artifacts/SAM-18/home.png", description: "Home page after change." }],
        notes: "No known reviewer caveats."
      }));
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 10);
  }
});
`;
}

function failingInspection(): PullRequestInspection {
  return {
    number: 10,
    url: "https://github.test/acme/widgets/pull/10",
    branch: "symphony/sam-10-close-pr-loop",
    title: "SAM-10: Close PR loop",
    state: "open",
    checks_status: "failure",
    review_status: "review_required",
    head_sha: "abc123def456",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #10 is open; checks=failure; review=review_required at abc123def456.",
    checks: [{ name: "verify", status: "completed", conclusion: "failure", details_url: "https://github.test/checks/10" }],
    reviews: [],
    review_comments: []
  };
}

function changesRequestedInspection(headSha: string): PullRequestInspection {
  return {
    number: 13,
    url: "https://github.test/acme/widgets/pull/13",
    branch: "symphony/sam-13-handle-stale-review",
    title: "SAM-13: Handle stale review",
    state: "open",
    checks_status: "success",
    review_status: "changes_requested",
    head_sha: headSha,
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: `PR #13 is open; checks=success; review=changes_requested at ${headSha}.`,
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/13" }],
    reviews: [
      {
        reviewer: "reviewer",
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-05-16T05:30:00.000Z",
        body: "Please address the review feedback.",
        url: "https://github.test/review/13",
        commit_id: "old-head-sha"
      }
    ],
    review_comments: []
  };
}

function commentOnlyInspection(): PullRequestInspection {
  return {
    number: 14,
    url: "https://github.test/acme/widgets/pull/14",
    branch: "symphony/sam-14-handle-comment-review",
    title: "SAM-14: Handle comment review",
    state: "open",
    checks_status: "success",
    review_status: "review_required",
    head_sha: "comment-head-sha",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #14 is open; checks=success; review=review_required at comment-head-sha.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/14" }],
    reviews: [
      {
        reviewer: "reviewer",
        state: "COMMENTED",
        submitted_at: "2026-05-16T05:31:00.000Z",
        body: "Please document the review-feedback loop.",
        url: "https://github.test/review/14",
        commit_id: "comment-head-sha"
      }
    ],
    review_comments: [
      {
        author: "reviewer",
        path: "src/orchestrator/orchestrator.ts",
        line: 42,
        body: "This needs an explicit regression test.",
        url: "https://github.test/comment/14",
        created_at: "2026-05-16T05:31:10.000Z",
        updated_at: "2026-05-16T05:31:10.000Z",
        commit_id: "comment-head-sha",
        original_commit_id: "comment-head-sha"
      }
    ]
  };
}

function conversationAndThreadInspection(): PullRequestInspection {
  return {
    number: 19,
    url: "https://github.test/acme/widgets/pull/19",
    branch: "symphony/sam-19-handle-pr-comments",
    title: "SAM-19: Handle PR comments",
    state: "open",
    checks_status: "success",
    review_status: "approved",
    head_sha: "conversation-head-sha",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #19 is open; checks=success; review=approved at conversation-head-sha.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/19" }],
    reviews: [
      {
        reviewer: "reviewer",
        state: "APPROVED",
        submitted_at: "2026-05-16T06:20:00.000Z",
        body: "Looks good after evidence is attached.",
        url: "https://github.test/review/19",
        commit_id: "conversation-head-sha"
      }
    ],
    review_comments: [],
    issue_comments: [
      {
        author: "reviewer",
        body: "Please add a screenshot before review.",
        url: "https://github.test/pr-comment/19",
        created_at: "2026-05-16T06:21:00.000Z",
        updated_at: "2026-05-16T06:21:00.000Z"
      }
    ],
    review_threads: [
      {
        id: "thread-19-open",
        is_resolved: false,
        is_outdated: false,
        path: "src/widget.ts",
        line: 88,
        comments: [
          {
            author: "reviewer",
            body: "This edge case still needs coverage.",
            url: "https://github.test/thread/19",
            created_at: "2026-05-16T06:22:00.000Z",
            updated_at: "2026-05-16T06:22:00.000Z",
            commit_id: "conversation-head-sha"
          }
        ]
      },
      {
        id: "thread-19-resolved",
        is_resolved: true,
        is_outdated: false,
        path: "src/old.ts",
        line: 12,
        comments: [
          {
            author: "reviewer",
            body: "Resolved feedback should not be actionable.",
            url: "https://github.test/thread/resolved",
            created_at: "2026-05-16T06:22:30.000Z",
            updated_at: "2026-05-16T06:22:30.000Z",
            commit_id: "conversation-head-sha"
          }
        ]
      }
    ]
  };
}

function movingReviewThreadInspection(headSha: string): PullRequestInspection {
  return {
    number: 20,
    url: "https://github.test/acme/widgets/pull/20",
    branch: "symphony/sam-20-handle-moving-review-thread",
    title: "SAM-20: Handle moving review thread",
    state: "open",
    checks_status: "success",
    review_status: "approved",
    head_sha: headSha,
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: `PR #20 is open; checks=success; review=approved at ${headSha}.`,
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/20" }],
    reviews: [
      {
        reviewer: "reviewer",
        state: "APPROVED",
        submitted_at: "2026-05-16T06:30:00.000Z",
        body: "Looks good after this thread is addressed.",
        url: "https://github.test/review/20",
        commit_id: headSha
      }
    ],
    review_comments: [],
    issue_comments: [],
    review_threads: [
      {
        id: "thread-20-open",
        is_resolved: false,
        is_outdated: false,
        path: "src/widget.ts",
        line: 88,
        comments: [
          {
            author: "reviewer",
            body: "This edge case still needs coverage.",
            url: "https://github.test/thread/20",
            created_at: "2026-05-16T06:31:00.000Z",
            updated_at: "2026-05-16T06:31:00.000Z",
            commit_id: headSha
          }
        ]
      }
    ]
  };
}

function approvedInspection(): PullRequestInspection {
  return {
    number: 16,
    url: "https://github.test/acme/widgets/pull/16",
    branch: "symphony/sam-16-merge-approved-pr",
    title: "SAM-16: Merge approved PR",
    state: "open",
    checks_status: "success",
    review_status: "approved",
    head_sha: "merge-head-sha",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #16 is open; checks=success; review=approved at merge-head-sha.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/16" }],
    reviews: [
      {
        reviewer: "reviewer",
        state: "APPROVED",
        submitted_at: "2026-05-16T06:45:00.000Z",
        body: "Approved.",
        url: "https://github.test/review/16",
        commit_id: "merge-head-sha"
      }
    ],
    review_comments: []
  };
}

function healthyInspection(): PullRequestInspection {
  return {
    number: 11,
    url: "https://github.test/acme/widgets/pull/11",
    branch: "symphony/sam-11-recovered-pr-should-not-redispatch",
    title: "SAM-11: Recovered PR should not redispatch",
    state: "open",
    checks_status: "success",
    review_status: "review_required",
    head_sha: "def456abc123",
    mergeable_state: "clean",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #11 is open; checks=success; review=review_required at def456abc123.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/11" }],
    reviews: [],
    review_comments: []
  };
}

function discoveredPullRequest(): DiscoveredPullRequest {
  return {
    number: 11,
    url: "https://github.test/acme/widgets/pull/11",
    branch: "symphony/sam-11-recovered-pr-should-not-redispatch",
    title: "SAM-11: Recovered PR should not redispatch",
    created: false,
    issue_identifier: "SAM-11"
  };
}

function mergedDiscoveredPullRequest(): DiscoveredPullRequest {
  return {
    number: 22,
    url: "https://github.test/acme/widgets/pull/22",
    branch: "symphony/sam-22-merged-while-offline",
    title: "SAM-22: Merged while offline",
    created: false,
    issue_identifier: "SAM-22"
  };
}

function mergedInspection(): PullRequestInspection {
  return {
    number: 22,
    url: "https://github.test/acme/widgets/pull/22",
    branch: "symphony/sam-22-merged-while-offline",
    title: "SAM-22: Merged while offline",
    state: "merged",
    checks_status: "success",
    review_status: "unknown",
    head_sha: "merged-head-sha",
    mergeable_state: "unknown",
    draft: false,
    checked_at: new Date().toISOString(),
    summary: "PR #22 is merged; checks=success; review=unknown at merged-head-sha.",
    checks: [{ name: "verify", status: "completed", conclusion: "success", details_url: "https://github.test/checks/22" }],
    reviews: [],
    review_comments: [],
    issue_comments: [],
    review_threads: []
  };
}

function durableSnapshot(dueAtMs: number): DurableStateSnapshot {
  return {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    retry_attempts: [{ issue_id: "retry-1", identifier: "SAM-12", attempt: 2, due_at_ms: dueAtMs, error: "verify failed", context: "Fix failing checks" }],
    completed_issue_ids: ["done-1"],
    issue_history: [
      {
        issue_id: "retry-1",
        issue_identifier: "SAM-12",
        workspace_path: null,
        restart_count: 1,
        last_error: "verify failed",
        run_attempts: [
          {
            attempt: 2,
            status: "running",
            started_at: "2026-01-01T00:00:00.000Z",
            finished_at: null,
            runtime_seconds: null,
            workspace_path: "/tmp/workspaces/SAM-12",
            session_id: "interrupted-session",
            turn_count: 3,
            error: null,
            followup: true
          }
        ],
        recent_events: [],
        tracked: {
          github_pull_request: {
            number: 12,
            url: "https://github.test/acme/widgets/pull/12",
            branch: "symphony/sam-12-durable-retry",
            title: "SAM-12: Durable retry",
            created: true
          }
        }
      }
    ],
    recent_events: [],
    codex_totals: { input_tokens: 1, output_tokens: 2, total_tokens: 3, seconds_running: 4 },
    codex_rate_limits: null
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
    evidence_file: "SYMPHONY_EVIDENCE.json",
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

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fakeCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } });
      send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { used: 1, limit: 100 } } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 10);
  }
});
`;
}

function fakeLongRunningCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  }
});
`;
}

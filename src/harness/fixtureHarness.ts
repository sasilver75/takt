import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Issue, SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { LocalTracker } from "../testing/localTracker.js";
import { WorkspaceManager } from "../workspace/manager.js";

type HarnessTarget = NonNullable<SymphonyConfig["target"]>;

export type ScriptedFixtureHarnessOptions = {
  tempPrefix: string;
  fixturePath: string;
  target: HarnessTarget;
  issue: Issue;
  scriptSource: string;
  workflowPrompt: string;
  reviewState?: string;
};

export type ScriptedFixtureHarness = {
  temp: string;
  workspace: string;
  cfg: SymphonyConfig;
  tracker: LocalTracker;
  logs: string[];
  orchestrator: Orchestrator;
  workspaceManager: WorkspaceManager;
  stop: () => Promise<void>;
};

export type HarnessSnapshot = {
  counts: { running: number; retrying: number; completed: number };
  codex_totals: { total_tokens: number };
};

export type ScriptedCodexServerOptions = {
  threadId: string;
  turnId: string;
  issueId: string;
  applyPatchSource: string;
  reviewState?: string;
};

export function scriptedCodexServerSource(options: ScriptedCodexServerOptions): string {
  const threadId = JSON.stringify(options.threadId);
  const turnId = JSON.stringify(options.turnId);
  const issueId = JSON.stringify(options.issueId);
  const reviewState = JSON.stringify(options.reviewState ?? "Human Review");
  return `
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

${options.applyPatchSource}

const rl = createInterface({ input: process.stdin });
let startedTurn = false;
let mcpAccepted = false;
let linearToolCompleted = false;
let patchApplied = false;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "mcp-approval-1" && msg.result) {
    mcpAccepted = msg.result.action === "accept";
    writeFileSync(path.join(process.cwd(), ".mcp-elicitation"), JSON.stringify(msg.result));
    maybeCompleteTurn();
    return;
  }
  if (msg.id === "tool-1" && msg.result) {
    linearToolCompleted = true;
    maybeCompleteTurn();
    return;
  }
  if (msg.method === "initialize") {
    const argv = process.argv.join("\\n");
    writeFileSync(path.join(process.cwd(), ".mcp-argv"), argv);
    writeFileSync(path.join(process.cwd(), ".mcp-env"), process.env.TAKT_LINEAR_CURRENT_ISSUE_IDENTIFIER || "");
    send({ id: msg.id, result: { userAgent: "scripted-codex", codexHome: process.cwd(), platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (msg.method === "thread/start") {
    writeFileSync(path.join(process.cwd(), ".base-instructions"), msg.params.baseInstructions || "");
    send({ id: msg.id, result: { thread: { id: ${threadId} }, cwd: process.cwd(), model: "scripted", modelProvider: "local", serviceTier: null, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: {}, reasoningEffort: null } });
    return;
  }
  if (msg.method === "turn/start" && !startedTurn) {
    startedTurn = true;
    const input = msg.params?.input?.[0]?.text || "";
    writeFileSync(path.join(process.cwd(), ".turn-input"), input);
    send({ id: msg.id, result: { turn: { id: ${turnId}, items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "turn/started", params: { threadId: ${threadId}, turn: { id: ${turnId}, items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: ${threadId}, turnId: ${turnId} } });
    send({ id: "mcp-approval-1", method: "mcpServer/elicitation/request", params: { threadId: ${threadId}, turnId: ${turnId}, serverName: "takt_linear", mode: "form", message: "Allow linear_graphql", requestedSchema: { type: "object", properties: {} }, _meta: null } });
    send({ method: "item/completed", params: { threadId: ${threadId}, turnId: ${turnId}, item: { id: "leak-check", output: "bridge test-capability-token" } } });
    send({ id: "tool-1", method: "item/tool/call", params: { threadId: ${threadId}, turnId: ${turnId}, tool: "linear_graphql", arguments: { query: "mutation UpdateIssue($id: ID!, $state: String!) { issueUpdate(id: $id, input: { state: $state }) { success } }", variables: { id: ${issueId}, state: ${reviewState} } } } });
  }
});

function maybeCompleteTurn() {
  if (!mcpAccepted || !linearToolCompleted || patchApplied) return;
  patchApplied = true;
  applyScenarioPatch();
  send({ method: "thread/tokenUsage/updated", params: { threadId: ${threadId}, turnId: ${turnId}, tokenUsage: { input_tokens: 111, output_tokens: 222, total_tokens: 333 } } });
  send({ method: "turn/completed", params: { threadId: ${threadId}, turn: { id: ${turnId}, status: "completed", items: [], itemsView: "all", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
}
`;
}

export async function runScriptedFixtureHarness(options: ScriptedFixtureHarnessOptions): Promise<ScriptedFixtureHarness> {
  const temp = await mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const fakeCodexPath = path.join(temp, "scripted-codex.mjs");
  await writeFile(fakeCodexPath, options.scriptSource);
  await chmod(fakeCodexPath, 0o755);

  const fixtureSource = path.resolve(options.fixturePath);
  const workspaceRoot = path.join(temp, "workspaces");
  const cfg = config(temp, workspaceRoot, `node ${shellQuote(fakeCodexPath)}`, fixtureSource, options.target);
  const tracker = new LocalTracker([options.issue]);
  const logs: string[] = [];
  const logger = createLogger((line) => logs.push(line));
  const workspaceManager = new WorkspaceManager(() => cfg, logger);
  const orchestrator = new Orchestrator({
    getConfig: () => cfg,
    getWorkflow: () => ({
      config: {},
      prompt_template: options.workflowPrompt,
      path: path.join(temp, "WORKFLOW.md"),
      loaded_at: new Date().toISOString()
    }),
    validateDispatch: async () => undefined,
    tracker,
    workspaceManager,
    linearTool: tracker,
    linearBridgeFactory: async ({ onEvent }) => {
      onEvent({ event: "linear_graphql_bridge_started", timestamp: new Date().toISOString(), message: "fake bridge ready" });
      return {
        url: "http://127.0.0.1:1/mcp",
        token: "test-capability-token",
        close: async () => undefined
      };
    },
    logger
  });

  await orchestrator.tick();
  const reviewState = options.reviewState ?? "Human Review";
  await waitFor(() => tracker.getIssue(options.issue.id)?.state === reviewState, `issue to reach ${reviewState}`);
  await waitFor(() => (orchestrator.snapshot() as HarnessSnapshot).counts.running === 0, "worker to exit");

  const workspace = workspaceManager.workspacePath(options.issue.identifier);
  await waitFor(async () => (await readFile(path.join(workspace, ".after-run"), "utf8")).includes("after"), "after_run hook");

  return {
    temp,
    workspace,
    cfg,
    tracker,
    logs,
    orchestrator,
    workspaceManager,
    stop: () => orchestrator.stop()
  };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function config(temp: string, workspaceRoot: string, command: string, fixtureSource: string, target: HarnessTarget): SymphonyConfig {
  return {
    workflowPath: path.join(temp, "WORKFLOW.md"),
    workflowDir: temp,
    target,
    tracker: {
      kind: "linear",
      endpoint: "local://tracker",
      api_key: "local-secret",
      project_slug: "toy",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
      claim_state: null,
      review_state: null
    },
    github: githubDisabled(),
    polling: { interval_ms: 60_000 },
    workspace: { root: workspaceRoot },
    runtime: { kind: "host" },
    hooks: {
      after_create: `cp -R ${shellQuote(fixtureSource)}/. .`,
      before_run: "printf before > .before-run",
      after_run: "printf after > .after-run",
      before_remove: null,
      timeout_ms: 5000
    },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 3,
      max_retry_backoff_ms: 1000,
      max_concurrent_agents_by_state: {}
    },
    codex: {
      command,
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 5000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 5000,
      linear_graphql_mcp: { enabled: true, server_name: "takt_linear" }
    },
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
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
    branch_prefix: "takt",
    pr_ready_file: "TAKT_PR_READY.json",
    evidence_file: "TAKT_EVIDENCE.json",
    draft: false,
    merge: {
      enabled: false,
      method: "squash",
      require_approval: true,
      require_successful_checks: true,
      require_clean_merge: true,
      delete_branch: true,
      complete_state: null
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

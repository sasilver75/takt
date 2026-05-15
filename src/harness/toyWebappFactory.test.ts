import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { issue } from "../testing/fakes.js";
import { LocalTracker } from "../testing/localTracker.js";
import { WorkspaceManager } from "../workspace/manager.js";

const execFileAsync = promisify(execFile);

describe("Symphony webapp production-factory harness", () => {
  test("drives a frontend/backend TypeScript app change through workspace, fake Codex, tracker tool, verification, and handoff", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-factory-"));
    const fakeCodexPath = path.join(temp, "scripted-codex.mjs");
    await writeFile(fakeCodexPath, scriptedCodexServerSource());
    await chmod(fakeCodexPath, 0o755);

    const toySource = path.resolve("examples/toy-webapp");
    const workspaceRoot = path.join(temp, "workspaces");
    const cfg = config(temp, workspaceRoot, `node ${fakeCodexPath}`, toySource);
    const tracker = new LocalTracker([
      issue({
        id: "toy-issue-1",
        identifier: "WEB-1",
        title: "Add operational health affordances",
        description:
          "Add a typed backend health endpoint and a frontend operations badge so agents can verify web app readiness from the UI and API.",
        priority: 1,
        state: "Todo"
      })
    ]);
    const logs: string[] = [];
    const logger = createLogger((line) => logs.push(line));
    const workspaceManager = new WorkspaceManager(() => cfg, logger);
    const orchestrator = new Orchestrator({
      getConfig: () => cfg,
      getWorkflow: () => ({
        config: {},
        prompt_template: [
          "You are improving a TypeScript web application.",
          "Issue: {{ issue.identifier }} - {{ issue.title }}",
          "{{ issue.description }}",
          "After implementation, use the linear_graphql tool to move the issue to Human Review."
        ].join("\n"),
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
          url: "http://127.0.0.1:1/linear_graphql",
          token: "test-capability-token",
          close: async () => undefined
        };
      },
      logger
    });

    await orchestrator.tick();
    await waitFor(() => tracker.getIssue("toy-issue-1")?.state === "Human Review", "issue to reach Human Review");
    await waitFor(() => (orchestrator.snapshot() as Snapshot).counts.running === 0, "worker to exit");

    const workspace = workspaceManager.workspacePath("WEB-1");
    await waitFor(async () => (await readFile(path.join(workspace, ".after-run"), "utf8")).includes("after"), "after_run hook");

    expect(await readFile(path.join(workspace, ".mcp-argv"), "utf8")).toContain("mcp_servers.symphony_linear.args");
    expect(await readFile(path.join(workspace, ".mcp-env"), "utf8")).toBe("WEB-1");
    const mcpScript = await readFile(path.join(workspace, ".mcp-script"), "utf8");
    expect(mcpScript).toContain("DEFAULT_BRIDGE_URL");
    expect(mcpScript).toContain("linear_graphql");
    expect(mcpScript).not.toContain("local-secret");
    expect(mcpScript).not.toContain("LINEAR_API_KEY");
    expect(await readFile(path.join(workspace, ".mcp-elicitation"), "utf8")).toContain('"action":"accept"');
    expect(await readFile(path.join(workspace, ".base-instructions"), "utf8")).toContain("linear_graphql");
    expect(await readFile(path.join(workspace, ".before-run"), "utf8")).toContain("before");
    expect(await readFile(path.join(workspace, "src", "health.ts"), "utf8")).toContain("getHealth");
    expect(await readFile(path.join(workspace, "src", "server.ts"), "utf8")).toContain("/api/health");
    expect(await readFile(path.join(workspace, "src", "public", "app.ts"), "utf8")).toContain("renderHealth");

    const tsc = path.resolve("node_modules/typescript/bin/tsc");
    await execFileAsync(process.execPath, [
      tsc,
      "-p",
      path.join(workspace, "tsconfig.json"),
      "--typeRoots",
      path.resolve("node_modules/@types")
    ]);
    const healthModule = (await import(pathToFileURL(path.join(workspace, "dist", "health.js")).href)) as {
      getHealth: () => { status: string; checks: { api: boolean; frontend: boolean } };
    };
    expect(healthModule.getHealth()).toMatchObject({ status: "ok", checks: { api: true, frontend: true } });
    expect(await readFile(path.join(workspace, "dist", "public", "app.js"), "utf8")).toContain("Service Health");

    const snapshot = orchestrator.snapshot() as Snapshot;
    expect(snapshot.codex_totals.total_tokens).toBeGreaterThan(0);
    expect(orchestrator.issueSnapshot("WEB-1")).toMatchObject({
      issue_identifier: "WEB-1",
      status: "retrying",
      workspace: { path: workspace }
    });
    expect(logs.some((line) => line.includes("approval_auto_approved"))).toBe(true);
    expect(logs.some((line) => line.includes("linear_graphql_tool_call"))).toBe(true);
    expect(logs.some((line) => line.includes("thread/tokenUsage/updated"))).toBe(true);

    await waitFor(() => (orchestrator.snapshot() as Snapshot).counts.retrying === 0, "continuation retry release");
    expect(orchestrator.issueSnapshot("WEB-1")).toMatchObject({ status: "completed" });
    await orchestrator.stop();
  }, 15000);
});

type Snapshot = {
  counts: { running: number; retrying: number; completed: number };
  codex_totals: { total_tokens: number };
};

function config(temp: string, workspaceRoot: string, command: string, toySource: string): SymphonyConfig {
  return {
    workflowPath: path.join(temp, "WORKFLOW.md"),
    workflowDir: temp,
    tracker: {
      kind: "linear",
      endpoint: "local://tracker",
      api_key: "local-secret",
      project_slug: "toy",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"]
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: workspaceRoot },
    hooks: {
      after_create: `cp -R ${shellQuote(toySource)}/. .`,
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
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    server: { port: null, host: "127.0.0.1" }
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function scriptedCodexServerSource(): string {
  return `
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rl = createInterface({ input: process.stdin });
let startedTurn = false;
let mcpAccepted = false;
let linearToolCompleted = false;

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function applyWebappPatch() {
  const cwd = process.cwd();
  writeFileSync(path.join(cwd, "src", "health.ts"), [
    "export type HealthResponse = {",
    "  status: \\"ok\\";",
    "  generatedAt: string;",
    "  checks: { api: boolean; frontend: boolean };",
    "};",
    "",
    "export function getHealth(): HealthResponse {",
    "  return {",
    "    status: \\"ok\\",",
    "    generatedAt: new Date().toISOString(),",
    "    checks: { api: true, frontend: true }",
    "  };",
    "}",
    ""
  ].join("\\n"));

  const serverPath = path.join(cwd, "src", "server.ts");
  let server = readFileSync(serverPath, "utf8");
  server = server.replace('import { TaskStore } from "./store.js";', 'import { TaskStore } from "./store.js";\\nimport { getHealth } from "./health.js";');
  server = server.replace(
    '  if (request.method === "GET" && url.pathname === "/api/tasks") {',
    '  if (request.method === "GET" && url.pathname === "/api/health") {\\n    writeJson(response, 200, getHealth());\\n    return;\\n  }\\n  if (request.method === "GET" && url.pathname === "/api/tasks") {'
  );
  server = server.replace(
    '<section class="summary" id="summary"></section>',
    '<section class="summary" id="summary"></section>\\n    <section class="panel" id="health-panel">Checking service health</section>'
  );
  writeFileSync(serverPath, server);

  const appPath = path.join(cwd, "src", "public", "app.ts");
  let app = readFileSync(appPath, "utf8");
  app = app.replace('const list = requireElement<HTMLUListElement>("#task-list");', 'const list = requireElement<HTMLUListElement>("#task-list");\\nconst healthPanel = requireElement<HTMLElement>("#health-panel");');
  app = app.replace("await render();", "await render();\\nawait renderHealth();");
  app += [
    "",
    "async function renderHealth(): Promise<void> {",
    "  const response = await fetch(\\"/api/health\\");",
    "  const health = (await response.json()) as { status: string; generatedAt: string };",
    "  healthPanel.innerHTML = \\"<strong>Service Health</strong> \\" + health.status + \\" <span>\\" + health.generatedAt + \\"</span>\\";",
    "}",
    ""
  ].join("\\n");
  writeFileSync(appPath, app);
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
    const scriptMatch = argv.match(/args=\\[\\"([^\\"]*linear-graphql-mcp\\.mjs)\\"\\]/);
    if (scriptMatch) writeFileSync(path.join(process.cwd(), ".mcp-script"), readFileSync(scriptMatch[1], "utf8"));
    writeFileSync(path.join(process.cwd(), ".mcp-env"), process.env.SYMPHONY_LINEAR_CURRENT_ISSUE_IDENTIFIER || "");
    send({ id: msg.id, result: { userAgent: "scripted-codex", codexHome: process.cwd(), platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (msg.method === "thread/start") {
    writeFileSync(path.join(process.cwd(), ".base-instructions"), msg.params.baseInstructions || "");
    send({ id: msg.id, result: { thread: { id: "thread-web" }, cwd: process.cwd(), model: "scripted", modelProvider: "local", serviceTier: null, instructionSources: [], approvalPolicy: "never", approvalsReviewer: "client", sandbox: {}, reasoningEffort: null } });
    return;
  }
  if (msg.method === "turn/start" && !startedTurn) {
    startedTurn = true;
    send({ id: msg.id, result: { turn: { id: "turn-web-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "turn/started", params: { threadId: "thread-web", turn: { id: "turn-web-1", items: [], itemsView: "all", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-web" } });
    send({ id: "mcp-approval-1", method: "mcpServer/elicitation/request", params: { threadId: "thread-web", turnId: "turn-web-1", serverName: "symphony_linear", mode: "form", message: "Allow linear_graphql", requestedSchema: { type: "object", properties: {} }, _meta: null } });
    send({ id: "tool-1", method: "item/tool/call", params: { threadId: "thread-web", tool: "linear_graphql", arguments: { query: "mutation UpdateIssue($id: ID!, $state: String!) { issueUpdate(id: $id, input: { state: $state }) { success } }", variables: { id: "toy-issue-1", state: "Human Review" } } } });
  }
});

function maybeCompleteTurn() {
  if (!mcpAccepted || !linearToolCompleted) return;
  applyWebappPatch();
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-web", turnId: "turn-web-1", tokenUsage: { input_tokens: 111, output_tokens: 222, total_tokens: 333 } } });
  send({ method: "turn/completed", params: { threadId: "thread-web", turn: { id: "turn-web-1", status: "completed", items: [], itemsView: "all", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
}
`;
}

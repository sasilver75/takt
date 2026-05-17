import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { issue } from "../testing/fakes.js";
import { type HarnessSnapshot, runScriptedFixtureHarness, scriptedCodexServerSource, waitFor } from "./fixtureHarness.js";

const execFileAsync = promisify(execFile);

describe("Takt webapp production-factory harness", () => {
  test("drives a frontend/backend TypeScript app change through workspace, fake Codex, tracker tool, verification, and handoff", async () => {
    const harness = await runScriptedFixtureHarness({
      tempPrefix: "takt-factory-",
      fixturePath: "examples/toy-webapp",
      target: {
        name: "Toy Webapp",
        kind: "typescript-web",
        repository: "local://examples/toy-webapp",
        description: "Frontend/backend TypeScript fixture used to exercise Takt as a production factory.",
        instructions: ["Change backend and frontend together when the issue requires a full-stack affordance."],
        verification: ["tsc -p tsconfig.json"],
        evidence: ["Compile output is enough for this deterministic harness."],
        handoff: "Human Review"
      },
      issue: issue({
        id: "toy-issue-1",
        identifier: "WEB-1",
        title: "Add operational health affordances",
        description:
          "Add a typed backend health endpoint and a frontend operations badge so agents can verify web app readiness from the UI and API.",
        priority: 1,
        state: "Todo"
      }),
      workflowPrompt: [
        "You are improving a TypeScript web application.",
        "Issue: {{ issue.identifier }} - {{ issue.title }}",
        "{{ issue.description }}",
        "After implementation, use the linear_graphql tool to move the issue to Human Review."
      ].join("\n"),
      scriptSource: scriptedCodexServerSource({
        threadId: "thread-web",
        turnId: "turn-web-1",
        issueId: "toy-issue-1",
        applyPatchSource: webappPatchSource()
      })
    });

    try {
      const { workspace, logs, orchestrator } = harness;
      expect(await readFile(path.join(workspace, ".mcp-argv"), "utf8")).toContain("mcp_servers.takt_linear.url");
      expect(await readFile(path.join(workspace, ".mcp-env"), "utf8")).toBe("WEB-1");
      const mcpArgv = await readFile(path.join(workspace, ".mcp-argv"), "utf8");
      expect(mcpArgv).not.toContain("test-capability-token");
      expect(mcpArgv).not.toContain("local-secret");
      expect(mcpArgv).not.toContain("LINEAR_API_KEY");
      expect(await readFile(path.join(workspace, ".mcp-script"), "utf8").catch(() => "")).toBe("");
      expect(await readFile(path.join(workspace, ".mcp-elicitation"), "utf8")).toContain('"action":"accept"');
      const baseInstructions = await readFile(path.join(workspace, ".base-instructions"), "utf8");
      expect(baseInstructions).toContain("Target application contract");
      expect(baseInstructions).toContain("name=Toy Webapp");
      expect(baseInstructions).toContain("kind=typescript-web");
      expect(baseInstructions).toContain("linear_graphql");
      expect(baseInstructions).toContain("Takt runtime internals");
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

      const snapshot = orchestrator.snapshot() as HarnessSnapshot;
      expect(snapshot.codex_totals.total_tokens).toBeGreaterThan(0);
      const issueSnapshot = orchestrator.issueSnapshot("WEB-1") as { status: string } | null;
      expect(issueSnapshot).toMatchObject({
        issue_identifier: "WEB-1",
        workspace: { path: workspace }
      });
      expect(["retrying", "known"]).toContain(issueSnapshot?.status);
      expect(logs.some((line) => line.includes("approval_auto_approved"))).toBe(true);
      expect(logs.some((line) => line.includes("linear_graphql_tool_call"))).toBe(true);
      expect(logs.some((line) => line.includes("thread/tokenUsage/updated"))).toBe(true);
      const logText = logs.join("\n");
      expect(logText).not.toContain("test-capability-token");
      expect(logText).toContain("[redacted]");

      await waitFor(() => (orchestrator.snapshot() as HarnessSnapshot).counts.retrying === 0, "continuation retry release");
      expect(orchestrator.issueSnapshot("WEB-1")).toMatchObject({ status: "known" });
    } finally {
      await harness.stop();
    }
  }, 15000);
});

function webappPatchSource(): string {
  return `
function applyScenarioPatch() {
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
`;
}

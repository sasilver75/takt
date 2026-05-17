import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { issue } from "../testing/fakes.js";
import {
  type HarnessSnapshot,
  type ScriptedFixtureHarness,
  runScriptedFixtureHarness,
  scriptedCodexServerSource,
  waitFor
} from "./fixtureHarness.js";

const execFileAsync = promisify(execFile);

describe("Takt runnable fixture scenario matrix", () => {
  test("drives a Go HTTP service fixture through fake Codex, verification, and handoff", async () => {
    const harness = await runScriptedFixtureHarness({
      tempPrefix: "takt-go-fixture-",
      fixturePath: "examples/toy-go-service",
      target: {
        name: "Toy Go Service",
        kind: "go-service",
        repository: "local://examples/toy-go-service",
        description: "Tiny Go HTTP service fixture for app-shaped orchestration coverage.",
        instructions: ["Keep HTTP handlers small and cover them with httptest."],
        verification: ["go test ./..."],
        evidence: ["Go test output is enough for this deterministic harness."],
        handoff: "Human Review"
      },
      issue: issue({
        id: "toy-go-issue-1",
        identifier: "GO-1",
        title: "Add readiness endpoint",
        description: "Expose a readiness endpoint that returns deterministic checks for reviewers.",
        priority: 1,
        state: "Todo"
      }),
      workflowPrompt: [
        "You are improving a Go HTTP service.",
        "Target {{ target.name }} kind={{ target.kind }}",
        "Issue: {{ issue.identifier }} - {{ issue.title }}",
        "Verification: {{ target.verification | first }}",
        "After implementation, use the linear_graphql tool to move the issue to Human Review."
      ].join("\n"),
      scriptSource: scriptedCodexServerSource({
        threadId: "thread-go",
        turnId: "turn-go-1",
        issueId: "toy-go-issue-1",
        applyPatchSource: goServicePatchSource()
      })
    });

    try {
      const { workspace } = harness;
      await expectHarnessSignals(harness, "GO-1", "Toy Go Service", "go-service", "go test ./...");
      expect(await readFile(path.join(workspace, "main.go"), "utf8")).toContain("/readyz");
      expect(await readFile(path.join(workspace, "readiness.go"), "utf8")).toContain("ReadinessResponse");
      expect(await readFile(path.join(workspace, "readiness_test.go"), "utf8")).toContain("TestReadyEndpoint");
      const goCache = path.join(workspace, ".gocache");
      await mkdir(goCache, { recursive: true });
      await execFileAsync("go", ["test", "./..."], { cwd: workspace, env: { ...process.env, GOCACHE: goCache } });
      await expectContinuationReleased(harness, "GO-1");
    } finally {
      await harness.stop();
    }
  }, 15000);

  test("drives a no-server Node CLI fixture through fake Codex, verification, and handoff", async () => {
    const harness = await runScriptedFixtureHarness({
      tempPrefix: "takt-cli-fixture-",
      fixturePath: "examples/toy-node-cli",
      target: {
        name: "Toy Node CLI",
        kind: "node-cli",
        repository: "local://examples/toy-node-cli",
        description: "No-server CLI/library fixture for deterministic package checks.",
        instructions: ["Keep CLI output stable and assert it with node:test."],
        verification: ["node --test"],
        evidence: ["Node test output is enough for this deterministic harness."],
        handoff: "Human Review"
      },
      issue: issue({
        id: "toy-cli-issue-1",
        identifier: "CLI-1",
        title: "Add priority summary output",
        description: "Expose high-priority open work in the CLI summary output.",
        priority: 1,
        state: "Todo"
      }),
      workflowPrompt: [
        "You are improving a no-server Node CLI package.",
        "Target {{ target.name }} kind={{ target.kind }}",
        "Issue: {{ issue.identifier }} - {{ issue.title }}",
        "Verification: {{ target.verification | first }}",
        "After implementation, use the linear_graphql tool to move the issue to Human Review."
      ].join("\n"),
      scriptSource: scriptedCodexServerSource({
        threadId: "thread-cli",
        turnId: "turn-cli-1",
        issueId: "toy-cli-issue-1",
        applyPatchSource: nodeCliPatchSource()
      })
    });

    try {
      const { workspace } = harness;
      await expectHarnessSignals(harness, "CLI-1", "Toy Node CLI", "node-cli", "node --test");
      expect(await readFile(path.join(workspace, "src", "summary.js"), "utf8")).toContain("highPriorityOpen");
      expect(await readFile(path.join(workspace, "tests", "priority.test.js"), "utf8")).toContain("high_priority_open=1");
      await execFileAsync(process.execPath, ["--test"], { cwd: workspace });
      await expectContinuationReleased(harness, "CLI-1");
    } finally {
      await harness.stop();
    }
  }, 15000);
});

async function expectHarnessSignals(
  harness: ScriptedFixtureHarness,
  issueIdentifier: string,
  targetName: string,
  targetKind: string,
  verificationCommand: string
): Promise<void> {
  const { workspace, logs, orchestrator } = harness;
  expect(await readFile(path.join(workspace, ".before-run"), "utf8")).toContain("before");
  expect(await readFile(path.join(workspace, ".after-run"), "utf8")).toContain("after");
  expect(await readFile(path.join(workspace, ".mcp-env"), "utf8")).toBe(issueIdentifier);
  expect(await readFile(path.join(workspace, ".mcp-argv"), "utf8")).toContain("mcp_servers.takt_linear.url");
  expect(await readFile(path.join(workspace, ".mcp-elicitation"), "utf8")).toContain('"action":"accept"');
  const baseInstructions = await readFile(path.join(workspace, ".base-instructions"), "utf8");
  expect(baseInstructions).toContain(`name=${targetName}`);
  expect(baseInstructions).toContain(`kind=${targetKind}`);
  expect(baseInstructions).toContain(verificationCommand);
  expect(baseInstructions).toContain("linear_graphql");
  const turnInput = await readFile(path.join(workspace, ".turn-input"), "utf8");
  expect(turnInput).toContain(issueIdentifier);
  expect(turnInput).toContain(verificationCommand);
  const snapshot = orchestrator.snapshot() as HarnessSnapshot;
  expect(snapshot.codex_totals.total_tokens).toBeGreaterThan(0);
  const issueSnapshot = orchestrator.issueSnapshot(issueIdentifier) as { status: string } | null;
  expect(issueSnapshot).toMatchObject({
    issue_identifier: issueIdentifier,
    workspace: { path: workspace }
  });
  expect(["retrying", "known"]).toContain(issueSnapshot?.status);
  expect(logs.some((line) => line.includes("approval_auto_approved"))).toBe(true);
  expect(logs.some((line) => line.includes("linear_graphql_tool_call"))).toBe(true);
  expect(logs.some((line) => line.includes("thread/tokenUsage/updated"))).toBe(true);
  const logText = logs.join("\n");
  expect(logText).not.toContain("test-capability-token");
  expect(logText).toContain("[redacted]");
}

async function expectContinuationReleased(harness: ScriptedFixtureHarness, issueIdentifier: string): Promise<void> {
  await waitFor(() => (harness.orchestrator.snapshot() as HarnessSnapshot).counts.retrying === 0, "continuation retry release");
  expect(harness.orchestrator.issueSnapshot(issueIdentifier)).toMatchObject({ status: "known" });
}

function goServicePatchSource(): string {
  return `
function applyScenarioPatch() {
  const cwd = process.cwd();
  writeFileSync(path.join(cwd, "readiness.go"), [
    "package main",
    "",
    "import \\"net/http\\"",
    "",
    "type ReadinessResponse struct {",
    "  Ready bool \`json:\\"ready\\"\`",
    "  Checks map[string]bool \`json:\\"checks\\"\`",
    "}",
    "",
    "func Readiness() ReadinessResponse {",
    "  return ReadinessResponse{",
    "    Ready: true,",
    "    Checks: map[string]bool{\\"http\\": true, \\"dependencies\\": true},",
    "  }",
    "}",
    "",
    "func handleReadiness(w http.ResponseWriter, r *http.Request) {",
    "  writeJSON(w, http.StatusOK, Readiness())",
    "}",
    ""
  ].join("\\n"));

  const mainPath = path.join(cwd, "main.go");
  let main = readFileSync(mainPath, "utf8");
  main = main.replace(
    'mux.HandleFunc("/healthz", handleHealth)\\n\\treturn mux',
    'mux.HandleFunc("/healthz", handleHealth)\\n\\tmux.HandleFunc("/readyz", handleReadiness)\\n\\treturn mux'
  );
  writeFileSync(mainPath, main);

  writeFileSync(path.join(cwd, "readiness_test.go"), [
    "package main",
    "",
    "import (",
    "  \\"net/http\\"",
    "  \\"net/http/httptest\\"",
    "  \\"strings\\"",
    "  \\"testing\\"",
    ")",
    "",
    "func TestReadyEndpoint(t *testing.T) {",
    "  request := httptest.NewRequest(http.MethodGet, \\"/readyz\\", nil)",
    "  response := httptest.NewRecorder()",
    "",
    "  NewServer().ServeHTTP(response, request)",
    "",
    "  if response.Code != http.StatusOK {",
    "    t.Fatalf(\\"status code = %d, want %d\\", response.Code, http.StatusOK)",
    "  }",
    "  body := response.Body.String()",
    "  if !strings.Contains(body, \\"ready\\") {",
    "    t.Fatalf(\\"body = %q, want ready response\\", body)",
    "  }",
    "}",
    ""
  ].join("\\n"));
}
`;
}

function nodeCliPatchSource(): string {
  return `
function applyScenarioPatch() {
  const cwd = process.cwd();
  const summaryPath = path.join(cwd, "src", "summary.js");
  let source = readFileSync(summaryPath, "utf8");
  source = source.replace(
    '    done: tasks.filter((task) => task.status === "done").length\\n  };',
    '    done: tasks.filter((task) => task.status === "done").length,\\n    highPriorityOpen: tasks.filter((task) => task.status !== "done" && task.priority === "high").length\\n  };'
  );
  source = source.replace(
    '    "done=" + summary.done\\n  ].join("\\\\n");',
    '    "done=" + summary.done,\\n    "high_priority_open=" + summary.highPriorityOpen\\n  ].join("\\\\n");'
  );
  writeFileSync(summaryPath, source);

  const summaryTestPath = path.join(cwd, "tests", "summary.test.js");
  let testSource = readFileSync(summaryTestPath, "utf8");
  testSource = testSource.replace(
    '"total=2\\\\nopen=1\\\\ndone=1"',
    '"total=2\\\\nopen=1\\\\ndone=1\\\\nhigh_priority_open=1"'
  );
  writeFileSync(summaryTestPath, testSource);

  writeFileSync(path.join(cwd, "tests", "priority.test.js"), [
    "import assert from \\"node:assert/strict\\";",
    "import { test } from \\"node:test\\";",
    "import { formatSummary, parseTasks, summarizeTasks } from \\"../src/summary.js\\";",
    "",
    "test(\\"includes high-priority open tasks in summary output\\", () => {",
    "  const tasks = parseTasks(\\"Escalate outage,open,high\\\\nClose release,done,high\\\\nTriage bug,open,normal\\\\n\\");",
    "  assert.equal(formatSummary(summarizeTasks(tasks)), \\"total=3\\\\nopen=2\\\\ndone=1\\\\nhigh_priority_open=1\\");",
    "});",
    ""
  ].join("\\n"));
}
`;
}

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { formatWorkflowDoctorReport, runWorkflowDoctor } from "./doctor.js";

describe("workflow doctor", () => {
  test("reports a ready host workflow with actionable warnings only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-doctor-ready-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, readyWorkflow({ runtime: "host" }));

    const report = await runWorkflowDoctor({
      workflowPath,
      env: { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret" }
    });
    const output = formatWorkflowDoctorReport(report);

    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.severity === "error")).toBe(false);
    expect(output).toContain("[OK] workflow:");
    expect(output).toContain("Summary: 0 error(s)");
  });

  test("reports missing env, missing docker image, and weak target contract", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-doctor-errors-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "target:",
        "  kind: typescript-web",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: demo",
        "github:",
        "  enabled: true",
        "  owner: acme",
        "  repo: webapp",
        "  token: $GITHUB_TOKEN",
        "runtime:",
        "  kind: docker",
        "  docker:",
        "    image: missing-worker:latest",
        "---",
        "Work {{ issue.identifier }}"
      ].join("\n")
    );

    const report = await runWorkflowDoctor({
      workflowPath,
      env: {},
      dockerImageExists: async () => false
    });
    const output = formatWorkflowDoctorReport(report);

    expect(report.ok).toBe(false);
    expect(output).toContain("LINEAR_API_KEY is required");
    expect(output).toContain("GITHUB_TOKEN is required");
    expect(output).toContain("Docker image missing-worker:latest was not found locally");
    expect(output).toContain("target.name is missing");
  });

  test("flags Apple host targets that accidentally use Docker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-doctor-ios-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, readyWorkflow({ runtime: "docker", targetKind: "ios-host" }));

    const report = await runWorkflowDoctor({
      workflowPath,
      env: { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret" },
      dockerImageExists: async () => true
    });
    const output = formatWorkflowDoctorReport(report);

    expect(report.ok).toBe(false);
    expect(output).toContain("Apple/Xcode-style target is configured with Docker runtime");
  });
});

function readyWorkflow(options: { runtime: "host" | "docker"; targetKind?: string }): string {
  const runtime =
    options.runtime === "host"
      ? ["runtime:", "  kind: host"]
      : ["runtime:", "  kind: docker", "  docker:", "    image: takt-codex-worker:latest"];
  return [
    "---",
    "target:",
    "  name: Acme API",
    `  kind: ${options.targetKind ?? "go-service"}`,
    "  repository: github.com/acme/api",
    "  verification:",
    "    - go test ./...",
    "  handoff: GitHub PR for review",
    "tracker:",
    "  api_key: $LINEAR_API_KEY",
    "  project_slug: demo",
    "  active_states:",
    "    - Ready",
    "    - In Progress",
    "  claim_state: In Progress",
    "  review_state: Needs Human",
    "github:",
    "  enabled: true",
    "  owner: acme",
    "  repo: api",
    "  token: $GITHUB_TOKEN",
    ...runtime,
    "hooks:",
    "  after_create: git clone https://github.com/acme/api.git .",
    "  before_run: git fetch origin main && git rebase origin/main",
    "---",
    "Work on {{ issue.identifier }} for {{ target.name }}."
  ].join("\n");
}

import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildReleaseGatePlan,
  parsePublicationCanaryArtifacts,
  RELEASE_CANARY_FLAG,
  RELEASE_FULL_CANARY_FLAG,
  RELEASE_LIVE_FLAG,
  runReleaseGate,
  type ReleaseGateCommand,
  type ReleaseGateCommandResult
} from "./releaseGate.js";
import { PUBLICATION_CANARY_FAILPOINTS } from "./livePublicationCanary.js";

describe("release gate", () => {
  test("defaults to local verify with live and canary checks skipped", () => {
    const plan = buildReleaseGatePlan([], {}, "/repo");

    expect(plan.workflowPath).toBe(path.resolve("/repo/examples/WORKFLOW.md"));
    expect(plan.reportPath).toBe(path.resolve("/repo/.takt/release-gate/latest.json"));
    expect(plan.verify).toBe(true);
    expect(plan.live).toBe(false);
    expect(plan.canary).toBe(false);
    expect(plan.canaryFailpoints).toEqual(["branch_pushed"]);
    expect(plan.errors).toEqual([]);
  });

  test("parses live and full-canary release gate flags from environment and args", () => {
    const env = {
      [RELEASE_LIVE_FLAG]: "1",
      [RELEASE_FULL_CANARY_FLAG]: "true",
      TAKT_LIVE_WORKFLOW: "from-env.md"
    };
    const envPlan = buildReleaseGatePlan([], env, "/repo");
    expect(envPlan.live).toBe(true);
    expect(envPlan.canary).toBe(true);
    expect(envPlan.fullCanary).toBe(true);
    expect(envPlan.workflowPath).toBe(path.resolve("/repo/from-env.md"));
    expect(envPlan.canaryFailpoints).toEqual([...PUBLICATION_CANARY_FAILPOINTS]);

    const argPlan = buildReleaseGatePlan(["--canary", "--failpoints", "branch_pushed,evidence_comment_published", "--report", "gate.json"], {}, "/repo");
    expect(argPlan.canary).toBe(true);
    expect(argPlan.fullCanary).toBe(false);
    expect(argPlan.canaryFailpoints).toEqual(["branch_pushed", "evidence_comment_published"]);
    expect(argPlan.reportPath).toBe(path.resolve("/repo/gate.json"));
  });

  test("parses publication canary pass lines into cleanup artifacts", () => {
    const artifacts = parsePublicationCanaryArtifacts([
      "START live publication canary matrix",
      "PASS branch_pushed: issue=https://linear.app/samcorp/issue/SAM-101/live pr=https://github.com/sasilver75/takt/pull/17 evidence=https://github.com/sasilver75/takt/pull/17#issuecomment-1 cleanup=completed",
      "PASS review_state_started: issue=SAM-102 pr=https://github.com/sasilver75/takt/pull/18 evidence=(none) cleanup=kept"
    ].join("\n"));

    expect(artifacts).toEqual([
      {
        failpoint: "branch_pushed",
        issue_identifier: "SAM-101",
        issue_url: "https://linear.app/samcorp/issue/SAM-101/live",
        pr_number: 17,
        pr_url: "https://github.com/sasilver75/takt/pull/17",
        evidence_url: "https://github.com/sasilver75/takt/pull/17#issuecomment-1",
        cleanup: "completed"
      },
      {
        failpoint: "review_state_started",
        issue_identifier: "SAM-102",
        issue_url: "SAM-102",
        pr_number: 18,
        pr_url: "https://github.com/sasilver75/takt/pull/18",
        evidence_url: null,
        cleanup: "kept"
      }
    ]);
  });

  test("runs verify, live preflight, canary, and residue verification when enabled", async () => {
    const commands: ReleaseGateCommand[] = [];
    const plan = buildReleaseGatePlan(["--live", "--canary", "--no-report"], { [RELEASE_CANARY_FLAG]: "0" }, "/repo");
    const report = await runReleaseGate(plan, {}, "/repo", {
      commandRunner: async (command) => {
        commands.push(command);
        return commandResult(stdoutFor(command));
      },
      residueVerifier: async ({ artifacts }) => ({
        status: "passed",
        message: `checked ${artifacts.length} artifact`,
        github_prs: [{ pr_number: 17, pr_url: "https://github.com/sasilver75/takt/pull/17", state: "closed", head_ref: "takt-canary/sam-101", branch_exists: false }],
        linear_issues: [{ issue_identifier: "SAM-101", state: "Canceled", terminal: true }]
      })
    });

    expect(report.status).toBe("passed");
    expect(report.commit).toBe("abc123");
    expect(report.steps.map((step) => [step.name, step.status])).toEqual([
      ["commit", "passed"],
      ["worktree", "passed"],
      ["local_verify", "passed"],
      ["live_preflight", "passed"],
      ["publication_canary", "passed"],
      ["residue_check", "passed"]
    ]);
    expect(report.canary_artifacts.map((artifact) => artifact.issue_identifier)).toEqual(["SAM-101"]);
    expect(commands.map((command) => [command.command, ...command.args].join(" "))).toEqual([
      "git rev-parse HEAD",
      "git status --porcelain",
      "pnpm verify",
      "pnpm integration:live -- --workflow /repo/examples/WORKFLOW.md",
      "pnpm integration:publication-canary -- --workflow /repo/examples/WORKFLOW.md --failpoints branch_pushed"
    ]);
    expect(commands[3]?.env.TAKT_LIVE_INTEGRATION).toBe("1");
    expect(commands[4]?.env.TAKT_LIVE_PUBLICATION_CANARY).toBe("1");
  });

  test("stops before live checks when local verify fails", async () => {
    const commands: string[] = [];
    const plan = buildReleaseGatePlan(["--live", "--canary", "--no-report"], {}, "/repo");
    const report = await runReleaseGate(plan, {}, "/repo", {
      commandRunner: async (command) => {
        commands.push([command.command, ...command.args].join(" "));
        if (command.command === "pnpm" && command.args[0] === "verify") return commandResult("", "test failed", 1);
        return commandResult(stdoutFor(command));
      }
    });

    expect(report.status).toBe("failed");
    expect(commands).toEqual(["git rev-parse HEAD", "git status --porcelain", "pnpm verify"]);
    expect(report.steps.map((step) => step.name)).toEqual(["commit", "worktree", "local_verify"]);
  });

  test("fails before verify when the worktree is dirty unless explicitly allowed", async () => {
    const dirtyRunner = async (command: ReleaseGateCommand) => {
      const line = [command.command, ...command.args].join(" ");
      if (line === "git rev-parse HEAD") return commandResult("abc123\n");
      if (line === "git status --porcelain") return commandResult(" M src/file.ts\n");
      return commandResult(`${line} ok\n`);
    };
    const strict = await runReleaseGate(buildReleaseGatePlan(["--no-report"], {}, "/repo"), {}, "/repo", { commandRunner: dirtyRunner });
    expect(strict.status).toBe("failed");
    expect(strict.steps.map((step) => step.name)).toEqual(["commit", "worktree"]);
    expect(strict.steps.at(-1)).toMatchObject({ status: "failed", message: "worktree has uncommitted changes" });

    const allowed = await runReleaseGate(buildReleaseGatePlan(["--allow-dirty", "--skip-verify", "--no-report"], {}, "/repo"), {}, "/repo", { commandRunner: dirtyRunner });
    expect(allowed.status).toBe("passed");
    expect(allowed.steps.find((step) => step.name === "worktree")).toMatchObject({
      status: "passed",
      message: "worktree has uncommitted changes; allowed by --allow-dirty"
    });
  });

  test("fails the gate when residue verification fails", async () => {
    const plan = buildReleaseGatePlan(["--canary", "--no-report"], {}, "/repo");
    const report = await runReleaseGate(plan, {}, "/repo", {
      commandRunner: async (command) => commandResult(stdoutFor(command)),
      residueVerifier: async () => ({
        status: "failed",
        message: "canary residue remains",
        github_prs: [{ pr_number: 17, pr_url: null, state: "open", head_ref: "takt-canary/sam-101", branch_exists: true }],
        linear_issues: [{ issue_identifier: "SAM-101", state: "Needs Human", terminal: false }]
      })
    });

    expect(report.status).toBe("failed");
    expect(report.steps.at(-1)).toMatchObject({ name: "residue_check", status: "failed", message: "canary residue remains" });
  });
});

function commandResult(stdout: string, stderr = "", exitCode = 0): ReleaseGateCommandResult {
  return { exitCode, stdout, stderr };
}

function stdoutFor(command: ReleaseGateCommand): string {
  const line = [command.command, ...command.args].join(" ");
  if (line === "git rev-parse HEAD") return "abc123\n";
  if (line === "git status --porcelain") return "";
  if (line.startsWith("pnpm integration:publication-canary")) {
    return "PASS branch_pushed: issue=https://linear.app/samcorp/issue/SAM-101/live pr=https://github.com/sasilver75/takt/pull/17 evidence=https://github.com/sasilver75/takt/pull/17#issuecomment-1 cleanup=completed\n";
  }
  return `${line} ok\n`;
}

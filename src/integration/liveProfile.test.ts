import path from "node:path";
import { describe, expect, test } from "vitest";
import type { WorkflowDefinition } from "../domain.js";
import { issue } from "../testing/fakes.js";
import {
  buildLiveIntegrationPlan,
  formatLiveIntegrationResult,
  LIVE_INTEGRATION_FLAG,
  LIVE_WORKFLOW_ENV,
  redactKnownSecrets,
  runLiveIntegrationProfile
} from "./liveProfile.js";

describe("live integration profile", () => {
  test("reports a visible skip by default", async () => {
    const plan = buildLiveIntegrationPlan([], {}, "/repo");
    const result = await runLiveIntegrationProfile(plan, {
      env: {},
      loadWorkflow: async () => {
        throw new Error("should not load workflow when skipped");
      }
    });

    expect(result.status).toBe("skipped");
    expect(result.message).toContain(LIVE_INTEGRATION_FLAG);
    expect(formatLiveIntegrationResult(result)[0]).toContain("SKIPPED real integration profile");
  });

  test("selects workflow path from args before environment default", () => {
    const env = { [LIVE_WORKFLOW_ENV]: "from-env.md" };
    expect(buildLiveIntegrationPlan(["--workflow", "from-arg.md"], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-arg.md"));
    expect(buildLiveIntegrationPlan(["--", "from-pnpm.md"], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-pnpm.md"));
    expect(buildLiveIntegrationPlan([], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-env.md"));
  });

  test("fails when explicitly enabled but required config is missing", async () => {
    const workflow = workflowWithConfig({
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "demo" },
      github: { enabled: true, owner: "acme", repo: "widgets", token: "$GITHUB_TOKEN" }
    });
    const env = { [LIVE_INTEGRATION_FLAG]: "1", LINEAR_API_KEY: "linear-secret-value" };
    const plan = buildLiveIntegrationPlan([], env, "/repo");
    const result = await runLiveIntegrationProfile(plan, { env, loadWorkflow: async () => workflow });

    expect(result.status).toBe("failed");
    expect(result.checks.map((check) => check.name)).toEqual(["workflow load", "dispatch config"]);
    expect(result.checks.at(-1)?.message).toContain("github.token is required");
  });

  test("runs non-mutating Linear and GitHub read checks when enabled", async () => {
    const env = { [LIVE_INTEGRATION_FLAG]: "1", LINEAR_API_KEY: "linear-secret-value", GITHUB_TOKEN: "github-secret-value" };
    const workflow = workflowWithConfig({
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "demo" },
      github: { enabled: true, owner: "acme", repo: "widgets", token: "$GITHUB_TOKEN" }
    });
    const githubRequests: string[] = [];
    const plan = buildLiveIntegrationPlan(["custom.md"], env, "/repo");
    const result = await runLiveIntegrationProfile(plan, {
      env,
      loadWorkflow: async () => workflow,
      linearClientFactory: () => ({ fetchCandidateIssues: async () => [issue({ identifier: "ABC-1" })] }),
      githubClientFactory: () => ({
        request: async (_method, route) => {
          githubRequests.push(route);
          return {};
        }
      })
    });

    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ["workflow load", "passed"],
      ["dispatch config", "passed"],
      ["linear candidate read", "passed"],
      ["github repo read", "passed"]
    ]);
    expect(result.checks.find((check) => check.name === "linear candidate read")?.message).toContain("read 1 candidate issue");
    expect(githubRequests).toEqual(["/repos/acme/widgets"]);
  });

  test("redacts known secret values from live failure messages", async () => {
    const env = { [LIVE_INTEGRATION_FLAG]: "1", LINEAR_API_KEY: "linear-secret-value" };
    const workflow = workflowWithConfig({
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "demo" }
    });
    const plan = buildLiveIntegrationPlan([], env, "/repo");
    const result = await runLiveIntegrationProfile(plan, {
      env,
      loadWorkflow: async () => workflow,
      linearClientFactory: () => ({
        fetchCandidateIssues: async () => {
          throw new Error("request failed with token linear-secret-value");
        }
      })
    });

    expect(result.status).toBe("failed");
    const message = result.checks.at(-1)?.message ?? "";
    expect(message).not.toContain("linear-secret-value");
    expect(message).toContain("[REDACTED:LINEAR_API_KEY]");
    expect(redactKnownSecrets("Bearer linear-secret-value", env)).toBe("Bearer [REDACTED:LINEAR_API_KEY]");
  });
});

function workflowWithConfig(config: Record<string, unknown>): WorkflowDefinition {
  return {
    config,
    prompt_template: "Do the work.",
    path: "/repo/WORKFLOW.md",
    loaded_at: "2026-01-01T00:00:00.000Z"
  };
}

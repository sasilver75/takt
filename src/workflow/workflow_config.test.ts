import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveConfig, validateDispatchConfig } from "../config/config.js";
import { SymphonyError } from "../errors.js";
import { renderIssuePrompt } from "./prompt.js";
import { loadWorkflow, selectWorkflowPath } from "./loader.js";
import { WorkflowRuntime } from "./runtime.js";
import { issue } from "../testing/fakes.js";
import { createLogger } from "../observability/logger.js";

describe("workflow loader and config", () => {
  test("selects explicit workflow path before cwd default", () => {
    expect(selectWorkflowPath("custom.md", "/repo")).toBe(path.resolve("/repo/custom.md"));
    expect(selectWorkflowPath(null, "/repo")).toBe(path.resolve("/repo/WORKFLOW.md"));
  });

  test("parses YAML front matter and prompt body", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  project_slug: demo\n---\nHello {{ issue.identifier }}`
    );
    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.tracker).toEqual({ kind: "linear", project_slug: "demo" });
    expect(workflow.prompt_template).toBe("Hello {{ issue.identifier }}");
  });

  test("returns typed loader errors", async () => {
    await expect(loadWorkflow("/missing/WORKFLOW.md")).rejects.toMatchObject({ code: "missing_workflow_file" });
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "---\n- nope\n---\nbody");
    await expect(loadWorkflow(workflowPath)).rejects.toMatchObject({ code: "workflow_front_matter_not_a_map" });
  });

  test("applies defaults, env indirection, path expansion, and normalized per-state concurrency", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_TOKEN\n  project_slug: demo\n  claim_state: In Progress\n  review_state: Needs Human\ngithub:\n  enabled: true\n  owner: acme\n  repo: widgets\n  token: $GITHUB_TOKEN\n  merge:\n    enabled: true\n    method: rebase\n    delete_branch: false\n    complete_state: Done\nworkspace:\n  root: workspaces\nruntime:\n  kind: docker\n  docker:\n    image: symphony-codex-worker:test\n    codex_home: $CODEX_HOME_TEST\nagent:\n  max_concurrent_agents_by_state:\n    Todo: 2\n    bad: 0\ncodex:\n  command: codex app-server --flag\n---\nbody`
    );
    const config = resolveConfig(await loadWorkflow(workflowPath), {
      LINEAR_TOKEN: "secret",
      GITHUB_TOKEN: "github-secret",
      CODEX_HOME_TEST: path.join(dir, ".codex")
    });
    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.api_key).toBe("secret");
    expect(config.tracker.claim_state).toBe("In Progress");
    expect(config.tracker.review_state).toBe("Needs Human");
    expect(config.github).toMatchObject({ enabled: true, owner: "acme", repo: "widgets", token: "github-secret", evidence_file: "SYMPHONY_EVIDENCE.json" });
    expect(config.github.merge).toMatchObject({
      enabled: true,
      method: "rebase",
      require_approval: true,
      require_successful_checks: true,
      require_clean_merge: true,
      delete_branch: false,
      complete_state: "Done"
    });
    expect(config.workspace.root).toBe(path.join(dir, "workspaces"));
    expect(config.agent.max_concurrent_agents_by_state).toEqual({ todo: 2 });
    expect(config.codex.command).toBe("codex app-server --flag");
    expect(config.runtime).toMatchObject({
      kind: "docker",
      docker: {
        image: "symphony-codex-worker:test",
        workspace_mount: "/workspace",
        codex_home: path.join(dir, ".codex"),
        mcp_host: "host.docker.internal"
      }
    });
    expect(() => validateDispatchConfig(config)).not.toThrow();
  });

  test("strict prompt rendering supports issue and attempt and rejects unknown variables", async () => {
    const workflow = {
      config: {},
      prompt_template: "Work {{ issue.identifier }} attempt={{ attempt }} context={{ followup_context }}",
      path: "/tmp/WORKFLOW.md",
      loaded_at: new Date().toISOString()
    };
    const prompt = await renderIssuePrompt(workflow, issue({ identifier: "ABC-9" }), 3, "checks failed");
    expect(prompt).toContain("ABC-9 attempt=3 context=checks failed");
    expect(prompt).toContain("Orchestrator follow-up context");
    await expect(renderIssuePrompt({ ...workflow, prompt_template: "{{ missing.value }}" }, issue(), null)).rejects.toMatchObject({
      code: "template_render_error"
    });
  });

  test("runtime reload keeps last good config after invalid change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-runtime-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "---\ntracker:\n  kind: linear\n  api_key: $TOKEN\n  project_slug: demo\npolling:\n  interval_ms: 25\n---\nbody");
    const logs: string[] = [];
    const runtime = new WorkflowRuntime({
      workflowPath,
      env: { TOKEN: "secret" },
      logger: createLogger((line) => logs.push(line))
    });
    await runtime.start();
    expect(runtime.getConfig().polling.interval_ms).toBe(25);
    await writeFile(workflowPath, "---\ntracker:\n  kind: linear\npolling:\n  interval_ms: nope\n---\nbody");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(runtime.getConfig().polling.interval_ms).toBe(25);
    expect(logs.some((line) => line.includes("workflow reload failed"))).toBe(true);
    runtime.close();
  });

  test("dispatch validation rejects missing credentials without printing secrets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "---\ntracker:\n  kind: linear\n  api_key: $MISSING\n  project_slug: demo\n---\nbody");
    const config = resolveConfig(await loadWorkflow(workflowPath), {});
    expect(() => validateDispatchConfig(config)).toThrow(SymphonyError);
    expect(() => validateDispatchConfig(config)).toThrow(/API key is missing/);
  });

  test("dispatch validation rejects a claim state outside active states", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: $TOKEN\n  project_slug: demo\n  active_states:\n    - Ready\n  claim_state: In Progress\n---\nbody"
    );
    const config = resolveConfig(await loadWorkflow(workflowPath), { TOKEN: "secret" });
    expect(() => validateDispatchConfig(config)).toThrow(/claim_state must also be listed/);
  });
});

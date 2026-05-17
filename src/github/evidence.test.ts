import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyConfig } from "../domain.js";
import { createLogger } from "../observability/logger.js";
import { GitHubPullRequestEvidencePublisher, renderEvidenceComment, SYMPHONY_EVIDENCE_COMMENT_MARKER } from "./evidence.js";
import { MAX_LOCAL_EVIDENCE_DIRECTORY_FILES } from "./evidenceArtifacts.js";

describe("GitHub PR evidence publisher", () => {
  test("creates a sticky PR evidence comment with reviewer artifacts", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.method ?? "GET") === "GET") return jsonResponse([]);
      return jsonResponse({ id: 123, html_url: "https://github.test/acme/widgets/pull/9#issuecomment-123" });
    };
    const publisher = new GitHubPullRequestEvidencePublisher(() => config("/tmp/symphony-gh-evidence"), createLogger(() => undefined), fetchImpl);

    await expect(
      publisher.publish({
        pullRequest: { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9", title: "SAM-9", created: true },
        workspacePath: "/tmp/workspace",
        manifest: {
          summary: "Verified the app flow.",
          verification: ["pnpm test", "npx playwright test"],
          commands: [
            { kind: "server", status: "started", command: "pnpm dev -- --host 127.0.0.1", description: "Launched the app for browser capture." },
            { kind: "capture", status: "succeeded", command: "symphony-capture-url http://127.0.0.1:3000 artifacts/SAM-9/home.png" }
          ],
          app_urls: ["http://127.0.0.1:3000"],
          artifacts: [
            { kind: "screenshot", path: "/workspace/artifacts/SAM-9/home.png", description: "Homepage after change." },
            { kind: "trace", url: "https://artifact.test/trace.zip" }
          ],
          notes: "No known reviewer caveats."
        }
      })
    ).resolves.toMatchObject({
      comment_id: 123,
      url: "https://github.test/acme/widgets/pull/9#issuecomment-123",
      warnings: [expect.stringContaining("was not found in the worker workspace")]
    });

    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.url).toBe("https://api.github.test/repos/acme/widgets/issues/9/comments");
    expect(requests[1]?.body).toMatchObject({
      body: expect.stringContaining(SYMPHONY_EVIDENCE_COMMENT_MARKER)
    });
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("artifacts/SAM-9/home.png");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("https://github.test/acme/widgets/blob/symphony/sam-9/artifacts/SAM-9/home.png");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("![screenshot: artifacts/SAM-9/home.png](https://github.test/acme/widgets/raw/symphony/sam-9/artifacts/SAM-9/home.png)");
    expect(String((requests[1]?.body as { body?: unknown }).body)).not.toContain("![trace:");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("npx playwright test");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("### Evidence Commands");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("server started: pnpm dev -- --host 127.0.0.1 - Launched the app for browser capture.");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("capture succeeded: symphony-capture-url http://127.0.0.1:3000 artifacts/SAM-9/home.png");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("### Artifact Warnings");
    expect(String((requests[1]?.body as { body?: unknown }).body)).toContain("was not found in the worker workspace");
  });

  test("updates an existing evidence comment when the marker is present", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(init?.method ?? "GET") === "GET") {
        return jsonResponse([{ id: 456, body: `${SYMPHONY_EVIDENCE_COMMENT_MARKER}\nold`, html_url: "https://github.test/comment/456" }]);
      }
      return jsonResponse({ id: 456, html_url: "https://github.test/comment/456" });
    };
    const publisher = new GitHubPullRequestEvidencePublisher(() => config("/tmp/symphony-gh-evidence"), createLogger(() => undefined), fetchImpl);

    await expect(publisher.publish({
      pullRequest: { number: 10, url: "https://github.test/acme/widgets/pull/10", branch: "symphony/sam-10", title: "SAM-10", created: false },
      workspacePath: "/tmp/workspace",
      manifest: { summary: "Updated evidence." }
    })).resolves.toMatchObject({ warnings: [] });

    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    expect(requests[1]?.url).toBe("https://api.github.test/repos/acme/widgets/issues/comments/456");
  });

  test("uploads local artifact files under artifacts to the PR branch before commenting", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-gh-evidence-upload-"));
    await mkdir(path.join(workspace, "artifacts", "SAM-9"), { recursive: true });
    await writeFile(path.join(workspace, "artifacts", "SAM-9", "report.txt"), "review evidence\n");
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/contents/artifacts/SAM-9/report.txt") && String(init?.method ?? "GET") === "GET") {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (String(init?.method ?? "GET") === "GET") return jsonResponse([]);
      if (String(init?.method ?? "GET") === "PUT") return jsonResponse({ content: { path: "artifacts/SAM-9/report.txt" } });
      return jsonResponse({ id: 321, html_url: "https://github.test/acme/widgets/pull/9#issuecomment-321" });
    };
    const publisher = new GitHubPullRequestEvidencePublisher(() => config("/tmp/symphony-gh-evidence"), createLogger(() => undefined), fetchImpl);

    await expect(publisher.publish({
      pullRequest: { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9", title: "SAM-9", created: true },
      workspacePath: workspace,
      manifest: {
        summary: "Verified with a local report.",
        artifacts: [{ kind: "report", path: "artifacts/SAM-9/report.txt", description: "Local reviewer report." }]
      }
    })).resolves.toMatchObject({ warnings: [] });

    const put = requests.find((request) => request.method === "PUT");
    expect(put?.url).toBe("https://api.github.test/repos/acme/widgets/contents/artifacts/SAM-9/report.txt");
    expect(put?.body).toMatchObject({
      branch: "symphony/sam-9",
      content: Buffer.from("review evidence\n").toString("base64"),
      message: "Add Symphony evidence artifact artifacts/SAM-9/report.txt"
    });
    const comment = requests.find((request) => request.method === "POST");
    const body = String((comment?.body as { body?: unknown } | undefined)?.body ?? "");
    expect(body).toContain("https://github.test/acme/widgets/blob/symphony/sam-9/artifacts/SAM-9/report.txt");
    expect(body).not.toContain("Artifact Warnings");
  });

  test("warns when local artifact directories exceed the upload file cap", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-gh-evidence-upload-cap-"));
    await mkdir(path.join(workspace, "artifacts", "SAM-9", "screens"), { recursive: true });
    for (let index = 0; index < MAX_LOCAL_EVIDENCE_DIRECTORY_FILES + 1; index += 1) {
      await writeFile(path.join(workspace, "artifacts", "SAM-9", "screens", `${String(index).padStart(3, "0")}.txt`), `file ${index}\n`);
    }
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/contents/artifacts/SAM-9/screens/") && String(init?.method ?? "GET") === "GET") {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (String(init?.method ?? "GET") === "GET") return jsonResponse([]);
      if (String(init?.method ?? "GET") === "PUT") return jsonResponse({ content: { path: "artifact" } });
      return jsonResponse({ id: 654, html_url: "https://github.test/acme/widgets/pull/9#issuecomment-654" });
    };
    const publisher = new GitHubPullRequestEvidencePublisher(() => config("/tmp/symphony-gh-evidence"), createLogger(() => undefined), fetchImpl);

    await expect(
      publisher.publish({
        pullRequest: { number: 9, url: "https://github.test/acme/widgets/pull/9", branch: "symphony/sam-9", title: "SAM-9", created: true },
        workspacePath: workspace,
        manifest: {
          summary: "Verified with many local artifacts.",
          artifacts: [{ kind: "report", path: "artifacts/SAM-9/screens", description: "Large local artifact directory." }]
        }
      })
    ).resolves.toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining(`more than ${MAX_LOCAL_EVIDENCE_DIRECTORY_FILES} files`)])
    });

    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(MAX_LOCAL_EVIDENCE_DIRECTORY_FILES);
    const comment = requests.find((request) => request.method === "POST");
    const body = String((comment?.body as { body?: unknown } | undefined)?.body ?? "");
    expect(body).toContain(`only the first ${MAX_LOCAL_EVIDENCE_DIRECTORY_FILES} files were considered for upload`);
  });

  test("recovers when the stored evidence comment id was deleted", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ method: String(init?.method ?? "GET"), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).endsWith("/issues/comments/456")) return jsonResponse({ message: "Not Found" }, 404);
      if (String(init?.method ?? "GET") === "GET") return jsonResponse([]);
      return jsonResponse({ id: 789, html_url: "https://github.test/comment/789" });
    };
    const publisher = new GitHubPullRequestEvidencePublisher(() => config("/tmp/symphony-gh-evidence"), createLogger(() => undefined), fetchImpl);

    await expect(
      publisher.publish({
        pullRequest: { number: 11, url: "https://github.test/acme/widgets/pull/11", branch: "symphony/sam-11", title: "SAM-11", created: false },
        workspacePath: "/tmp/workspace",
        manifest: { summary: "Fresh evidence." },
        previousCommentId: 456
      })
    ).resolves.toEqual({ comment_id: 789, url: "https://github.test/comment/789", warnings: [] });

    expect(requests.map((request) => request.method)).toEqual(["PATCH", "GET", "POST"]);
    expect(requests[2]?.url).toBe("https://api.github.test/repos/acme/widgets/issues/11/comments");
  });

  test("renders evidence comments deterministically", () => {
    const body = renderEvidenceComment(
      { number: 1, url: "https://github.test/acme/widgets/pull/1", branch: "symphony/sam-1", title: "SAM-1", created: true },
      {
        summary: "Done",
        artifacts: [
          { path: "artifacts/../artifacts/SAM-1/report.txt", label: "report" },
          { path: "/var/tmp/outside.txt", label: "outside" }
        ]
      },
      "/tmp/workspace"
    );
    expect(body).toContain(SYMPHONY_EVIDENCE_COMMENT_MARKER);
    expect(body).toContain("`artifacts/SAM-1/report.txt`");
    expect(body).not.toContain("outside");
  });

  test("renders artifact validation warnings when evidence paths are weak", () => {
    const body = renderEvidenceComment(
      { number: 2, url: "https://github.test/acme/widgets/pull/2", branch: "symphony/sam-2", title: "SAM-2", created: true },
      { summary: "Done", artifacts: [{ path: "artifacts/SAM-2/missing.png", kind: "screenshot" }] },
      "/tmp/workspace",
      { owner: "acme", repo: "widgets" },
      ["Artifact path was not found in the worker workspace at publish time: artifacts/SAM-2/missing.png"]
    );
    expect(body).toContain("### Artifact Warnings");
    expect(body).toContain("artifacts/SAM-2/missing.png");
  });
});

function config(root: string): SymphonyConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "linear-secret",
      project_slug: "demo",
      active_states: ["Ready", "In Progress"],
      terminal_states: ["Done"],
      claim_state: "In Progress",
      review_state: "Needs Human"
    },
    github: {
      enabled: true,
      owner: "acme",
      repo: "widgets",
      api_endpoint: "https://api.github.test",
      token: "github-secret-token",
      remote: "origin",
      base_branch: "main",
      branch_prefix: "symphony",
      pr_ready_file: "SYMPHONY_PR_READY.json",
      evidence_file: "SYMPHONY_EVIDENCE.json",
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
    },
    polling: { interval_ms: 1000 },
    workspace: { root: path.join(root, "workspaces") },
    runtime: { kind: "host" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex app-server",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
      linear_graphql_mcp: { enabled: true, server_name: "symphony_linear" }
    },
    observability: { recent_event_limit: 200, issue_event_limit: 50, run_attempt_limit: 50 },
    server: { port: null, host: "127.0.0.1" }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

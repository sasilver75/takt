import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createLogger } from "../observability/logger.js";
import { createHttpStatusServer } from "./server.js";

describe("HTTP status server", () => {
  test("serves dashboard, state, issue details, refresh, and method errors", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "symphony-http-artifacts-"));
    await mkdir(path.join(workspace, "artifacts", "ABC-1"), { recursive: true });
    await writeFile(path.join(workspace, "artifacts", "ABC-1", "home.png"), "fake image", "utf8");
    const orchestrator = {
      snapshot: () => ({
        generated_at: "2026-01-01T00:00:00.000Z",
        counts: { running: 1, retrying: 0, completed: 0, pull_requests: 1 },
        running: [{ issue_identifier: "ABC-1", state: "In Progress", turn_count: 2, last_event: "turn/started" }],
        retrying: [],
        pull_requests: [
          {
            issue_identifier: "ABC-1",
            pull_request: { number: 7, url: "https://github.test/acme/widgets/pull/7" },
            status: { state: "open", checks_status: "success", review_status: "review_required", summary: "PR #7 is open." },
            evidence: {
              comment_url: "https://github.test/acme/widgets/pull/7#issuecomment-1",
              warnings: ["Artifact path is not tracked by git at publish time"],
              manifest: {
                artifacts: [{ path: "artifacts/ABC-1/home.png" }],
                app_urls: ["http://127.0.0.1:3000"],
                verification: ["pnpm test"],
                commands: [{ kind: "server", status: "started", command: "pnpm dev -- --host 127.0.0.1", description: "Served the app for screenshot capture." }]
              }
            }
          }
        ],
        recent_events: [{ at: "2026-01-01T00:00:01.000Z", event: "turn/started", issue_identifier: "ABC-1", session_id: "session-1", message: "Worker started" }],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
        rate_limits: null
      }),
      issueSnapshot: (identifier: string) =>
        identifier === "ABC-1"
          ? {
              issue_identifier: "ABC-1",
              issue_id: "issue-1",
              status: "known",
              workspace: { path: workspace },
              attempts: {
                restart_count: 1,
                current_retry_attempt: null,
                run_attempts: [
                  {
                    attempt: 1,
                    status: "succeeded",
                    started_at: "2026-01-01T00:00:00.000Z",
                    finished_at: "2026-01-01T00:00:12.500Z",
                    runtime_seconds: 12.5,
                    workspace_path: workspace,
                    session_id: "session-1",
                    turn_count: 2,
                    error: null,
                    followup: true
                  }
                ]
              },
              running: null,
              retry: null,
              last_error: null,
              recent_events: [{ at: "2026-01-01T00:00:01.000Z", event: "turn/started", session_id: "session-1", message: "Worker started" }],
              tracked: {
                github_pull_request: { number: 7, url: "https://github.test/acme/widgets/pull/7", branch: "symphony/abc-1", title: "ABC-1: demo" },
                github_pull_request_status: {
                  state: "open",
                  checks_status: "success",
                  review_status: "review_required",
                  head_sha: "abc123",
                  summary: "PR #7 is open."
                },
                github_evidence_comment_url: "https://github.test/acme/widgets/pull/7#issuecomment-1",
                github_evidence_published_at: "2026-01-01T00:00:02.000Z",
                github_evidence_warnings: ["Artifact path is not tracked by git at publish time"],
                github_evidence_manifest: {
                  summary: "Verified in browser.",
                  artifacts: [{ kind: "screenshot", path: "artifacts/ABC-1/home.png", description: "Homepage" }],
                  app_urls: ["http://127.0.0.1:3000"],
                  verification: ["pnpm test"],
                  commands: [{ kind: "server", status: "started", command: "pnpm dev -- --host 127.0.0.1", description: "Served the app for screenshot capture." }]
                }
              }
            }
          : null,
      queueImmediateTick: () => ({ queued: true, coalesced: false })
    };
    const server = createHttpStatusServer({
      host: "127.0.0.1",
      port: 0,
      orchestrator: orchestrator as never,
      logger: createLogger(() => undefined)
    });
    let address: { host: string; port: number };
    try {
      address = await server.start();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM") {
        console.warn("Skipping live HTTP assertions because this sandbox disallows loopback binding.");
        return;
      }
      throw error;
    }
    const base = `http://${address.host}:${address.port}`;
    const dashboard = await (await fetch(`${base}/`)).text();
    expect(dashboard).toContain("Symphony Status");
    expect(dashboard).toContain("Recent Events");
    expect(dashboard).toContain("/issues/ABC-1");
    expect(dashboard).toContain("evidence (1 artifact, 1 app URL, 1 check, 1 command, 1 warning)");
    expect(dashboard).toContain("Worker started");
    const issuePage = await (await fetch(`${base}/issues/ABC-1`)).text();
    expect(issuePage).toContain("Issue ABC-1");
    expect(issuePage).toContain("/api/v1/ABC-1");
    expect(issuePage).toContain("artifacts/ABC-1/home.png");
    expect(issuePage).toContain("/artifacts/ABC-1/artifacts/ABC-1/home.png");
    expect(issuePage).toContain("Artifact path is not tracked by git at publish time");
    expect(issuePage).toContain("Verified in browser.");
    expect(issuePage).toContain("server started:");
    expect(issuePage).toContain("pnpm dev -- --host 127.0.0.1");
    expect(issuePage).toContain("Served the app for screenshot capture.");
    expect(issuePage).toContain("Run Attempts");
    expect(issuePage).toContain("succeeded");
    expect(issuePage).toContain("12.5");
    expect(issuePage).toContain("Worker started");
    expect((await (await fetch(`${base}/api/v1/state`)).json()).counts.running).toBe(1);
    expect((await (await fetch(`${base}/api/v1/ABC-1`)).json()).status).toBe("known");
    const artifacts = await (await fetch(`${base}/api/v1/ABC-1/artifacts`)).json();
    expect(artifacts).toMatchObject({
      issue_identifier: "ABC-1",
      artifacts: [
        {
          normalized_path: "artifacts/ABC-1/home.png",
          local_url: "/artifacts/ABC-1/artifacts/ABC-1/home.png"
        }
      ],
      files: [{ path: "artifacts/ABC-1/home.png", url: "/artifacts/ABC-1/artifacts/ABC-1/home.png" }]
    });
    const artifactResponse = await fetch(`${base}/artifacts/ABC-1/artifacts/ABC-1/home.png`);
    expect(artifactResponse.status).toBe(200);
    expect(artifactResponse.headers.get("content-type")).toBe("image/png");
    expect(artifactResponse.headers.get("content-security-policy")).toContain("sandbox");
    expect(await artifactResponse.text()).toBe("fake image");
    expect((await fetch(`${base}/artifacts/ABC-1/%2E%2E/keys.txt`)).status).toBe(404);
    expect((await fetch(`${base}/issues/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/state`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/refresh`, { method: "POST" })).status).toBe(202);
    await server.close();
  });
});

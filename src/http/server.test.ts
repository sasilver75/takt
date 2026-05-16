import { describe, expect, test } from "vitest";
import { createLogger } from "../observability/logger.js";
import { createHttpStatusServer } from "./server.js";

describe("HTTP status server", () => {
  test("serves dashboard, state, issue details, refresh, and method errors", async () => {
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
              manifest: { artifacts: [{ path: "artifacts/ABC-1/home.png" }], app_urls: ["http://127.0.0.1:3000"], verification: ["pnpm test"] }
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
              workspace: { path: "/tmp/symphony/ABC-1" },
              attempts: { restart_count: 1, current_retry_attempt: null },
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
                  verification: ["pnpm test"]
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
    expect(dashboard).toContain("evidence (1 artifact, 1 app URL, 1 check, 1 warning)");
    expect(dashboard).toContain("Worker started");
    const issuePage = await (await fetch(`${base}/issues/ABC-1`)).text();
    expect(issuePage).toContain("Issue ABC-1");
    expect(issuePage).toContain("/api/v1/ABC-1");
    expect(issuePage).toContain("artifacts/ABC-1/home.png");
    expect(issuePage).toContain("Artifact path is not tracked by git at publish time");
    expect(issuePage).toContain("Verified in browser.");
    expect(issuePage).toContain("Worker started");
    expect((await (await fetch(`${base}/api/v1/state`)).json()).counts.running).toBe(1);
    expect((await (await fetch(`${base}/api/v1/ABC-1`)).json()).status).toBe("known");
    expect((await fetch(`${base}/issues/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/state`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/refresh`, { method: "POST" })).status).toBe(202);
    await server.close();
  });
});

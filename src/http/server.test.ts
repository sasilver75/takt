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
              manifest: { artifacts: [{ path: "artifacts/ABC-1/home.png" }], app_urls: ["http://127.0.0.1:3000"], verification: ["pnpm test"] }
            }
          }
        ],
        recent_events: [{ at: "2026-01-01T00:00:01.000Z", event: "turn/started", issue_identifier: "ABC-1", session_id: "session-1", message: "Worker started" }],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
        rate_limits: null
      }),
      issueSnapshot: (identifier: string) => (identifier === "ABC-1" ? { issue_identifier: "ABC-1", status: "known" } : null),
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
    expect(dashboard).toContain("/api/v1/ABC-1");
    expect(dashboard).toContain("evidence (1 artifact, 1 app URL, 1 check)");
    expect(dashboard).toContain("Worker started");
    expect((await (await fetch(`${base}/api/v1/state`)).json()).counts.running).toBe(1);
    expect((await (await fetch(`${base}/api/v1/ABC-1`)).json()).status).toBe("known");
    expect((await fetch(`${base}/api/v1/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/state`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/refresh`, { method: "POST" })).status).toBe(202);
    await server.close();
  });
});

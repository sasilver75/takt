import { describe, expect, test } from "vitest";
import { createLogger } from "../observability/logger.js";
import { createHttpStatusServer } from "./server.js";

describe("HTTP status server", () => {
  test("serves dashboard, state, issue details, refresh, and method errors", async () => {
    const orchestrator = {
      snapshot: () => ({
        generated_at: "2026-01-01T00:00:00.000Z",
        counts: { running: 0, retrying: 0 },
        running: [],
        retrying: [],
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
    expect(await (await fetch(`${base}/`)).text()).toContain("Symphony Status");
    expect((await (await fetch(`${base}/api/v1/state`)).json()).counts.running).toBe(0);
    expect((await (await fetch(`${base}/api/v1/ABC-1`)).json()).status).toBe("known");
    expect((await fetch(`${base}/api/v1/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/state`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/refresh`, { method: "POST" })).status).toBe(202);
    await server.close();
  });
});

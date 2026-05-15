# Operations

## Running

```bash
LINEAR_API_KEY=... pnpm dev ./WORKFLOW.md --port 8787
```

The positional argument selects the workflow file. If omitted, Symphony uses `./WORKFLOW.md`.

`--port` enables the optional HTTP status surface and overrides `server.port` from workflow front matter. The server binds loopback by default.

`examples/WORKFLOW.md` targets the real Linear project `Gallatin Demo` in the `Samcorp` team. Linear's generated project slug is `5f14e4e68dc4`; the team handoff state is `Needs Human`.

## Workflow Reload

The service watches `WORKFLOW.md` and reloads config and prompt content without restart. Reloaded settings apply to future dispatch, retries, hooks, reconciliation, and agent launches. In-flight Codex sessions are not restarted just because config changed.

If reload fails, Symphony logs `workflow reload failed` and keeps using the last known good config.

## Safety Posture

This implementation uses a high-trust default posture suitable for trusted local automation:

- Codex command execution and file-change approval requests are auto-approved for the session.
- Codex user-input requests are not allowed to stall indefinitely; the client returns an empty response and records `turn_input_required`.
- Workspace isolation is filesystem-scoped: every agent subprocess is launched in the per-issue workspace and workspace paths must remain under `workspace.root`.
- Leave `workspace.root` unset unless there is a concrete deployment reason; the default temp-directory root avoids package-manager parent traversal into this repo.
- Hook scripts are trusted repository configuration and run in the workspace directory with `hooks.timeout_ms`.
- Linear credentials are resolved from workflow config/env indirection and are redacted from logs.
- Agent-side Linear actions should use the Symphony-owned `linear_graphql` tool exposed by the generated `symphony_linear` MCP server. The generated MCP script is written to `.symphony/linear-graphql-mcp.mjs` inside the issue workspace and receives only a short-lived loopback bridge capability. The Linear API key remains in the Symphony orchestrator process.

For a more restrictive deployment, set stricter Codex `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` values in `WORKFLOW.md`, and run Symphony under a dedicated OS/container/VM boundary with limited credentials.

## Observability

Structured logs are written as stable `key=value` lines. Issue logs include `issue_id` and `issue_identifier`; session lifecycle logs include `session_id` when available.

When the HTTP extension is enabled:

- `GET /` returns a human-readable dashboard.
- `GET /api/v1/state` returns running sessions, retry queue, token/runtime totals, and rate limits.
- `GET /api/v1/<issue_identifier>` returns issue-specific debug state.
- `POST /api/v1/refresh` queues an immediate poll/reconcile tick.
- `linear_graphql_mcp_configured`, `linear_graphql_bridge_started`, and `linear_graphql_tool_call` events show whether the Symphony-owned Linear tool was configured, had a live local bridge, and was used by a worker.

## Real Integration

The deterministic Vitest suite uses fake Linear/local tracker and fake Codex app-server harnesses. `pnpm test:factory` is the highest-signal local check: it copies `examples/toy-webapp` into an isolated workspace, lets a scripted app-server modify backend and frontend TypeScript, handles tool/approval requests, compiles the resulting app, and validates handoff status.

Live Linear/Codex checks are explicit operator actions because they require credentials, network access, and permission to touch real external systems.

Live runs performed on May 15, 2026:

- Linear project: `Gallatin Demo` (`5f14e4e68dc4`).
- `SAM-65`, `Validate Symphony live run on Gallatin Demo`: real Codex app-server ran through Symphony, created and locally committed `LIVE_RUN_RESULT.md` in the per-issue workspace, added a Linear handoff comment, and moved the issue to `Needs Human`. This first run exposed two operator issues: the GitHub remote still contained the placeholder source, and an in-repo workspace root allowed package-manager parent traversal.
- Corrections applied: pushed the TypeScript Symphony implementation to `origin/main` and returned the workflow to the default temp-directory workspace root.
- `SAM-66`, `Validate Symphony live run after GitHub source sync`: real Symphony cloned `origin/main` into an isolated temp workspace, Codex verified the checked-out repository contained the TypeScript implementation, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_REMOTE_RUN_RESULT.md` in the per-issue workspace, added a Linear handoff comment, and moved the issue to `Needs Human`.
- `SAM-67`, `Validate Symphony-owned Linear GraphQL tool path`: real Codex discovered the generated `symphony_linear` MCP server and attempted `linear_graphql`; the run exposed that app-server MCP elicitation responses require an `{ action, content }` shape.
- `SAM-68`, `Validate Symphony-owned Linear GraphQL tool path after elicitation fix`: real Codex reached the MCP tool after elicitation handling, then exposed that MCP subprocesses are not guaranteed to inherit the app-server process environment. Symphony now uses a loopback bridge so the MCP subprocess never needs the Linear API key.

Before production use:

- Verify the configured Linear project exists and has the intended active issue queue.
- Run Symphony against one controlled issue/workspace before allowing broader concurrency.
- Verify hooks on the target host shell.
- Confirm the chosen approval/sandbox policy matches the risk profile.

## Verification Commands

- `pnpm typecheck`: typechecks the Symphony service.
- `pnpm test`: runs unit and deterministic integration tests.
- `pnpm test:factory`: runs only the toy web-app production-factory harness.
- `pnpm toy:typecheck`: typechecks the toy frontend/backend fixture.
- `pnpm verify`: runs the full local gate used by CI.

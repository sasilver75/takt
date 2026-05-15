# Operations

## Running

```bash
docker build -f docker/codex-worker.Dockerfile -t symphony-codex-worker:latest .
LINEAR_API_KEY=... pnpm dev ./WORKFLOW.md --port 8787
```

The positional argument selects the workflow file. If omitted, Symphony uses `./WORKFLOW.md`.

`--port` enables the optional HTTP status surface and overrides `server.port` from workflow front matter. The server binds loopback by default.

`examples/WORKFLOW.md` targets the real Linear project `Gallatin Demo` in the `Samcorp` team. Linear's generated project slug is `5f14e4e68dc4`; the team handoff state is `Needs Human`.

## Workflow Reload

The service watches `WORKFLOW.md` and reloads config and prompt content without restart. Reloaded settings apply to future dispatch, retries, hooks, reconciliation, and agent launches. In-flight Codex sessions are not restarted just because config changed.

If reload fails, Symphony logs `workflow reload failed` and keeps using the last known good config.

## Safety Posture

This implementation treats Docker as the first-class worker runtime. `runtime.kind: docker` runs Codex app-server inside a per-issue container with the issue workspace mounted at `/workspace`; `runtime.kind: host` remains available for local debugging and deterministic tests.

The default Docker worker image can be built with:

```bash
docker build -f docker/codex-worker.Dockerfile -t symphony-codex-worker:latest .
```

The current safety posture is:

- Codex command execution and file-change approval requests are auto-approved for the session.
- Codex user-input requests are not allowed to stall indefinitely; the client returns an empty response and records `turn_input_required`.
- Workspace isolation is runtime-scoped: every agent subprocess is launched in the per-issue workspace inside the selected runtime, and host workspace paths must remain under `workspace.root`.
- Leave `workspace.root` unset unless there is a concrete deployment reason; the default temp-directory root avoids package-manager parent traversal into this repo.
- `after_create` and `before_remove` hooks are host workspace lifecycle hooks. `before_run` and `after_run` execute through the selected worker runtime, so Docker workflows install dependencies and write run evidence inside the same container filesystem view used by Codex.
- Linear credentials are resolved from workflow config/env indirection, redacted from logs, and scrubbed from the Codex app-server child environment.
- Agent-side Linear actions should use the Symphony-owned `linear_graphql` tool exposed by the `symphony_linear` MCP server. Symphony hosts that MCP server on a short-lived Streamable HTTP endpoint and registers only its runtime URL with Codex; no Linear API key or bridge token is written into the worker workspace. Docker workers use an MCP bearer-token env var rather than an argv or workspace-file secret.
- Docker workers receive a runtime lease env including `SYMPHONY_RUN_ID`, `SYMPHONY_PORT_BASE`, `PORT`, `APP_PORT`, `VITE_PORT`, `DATABASE_PORT`, `REDIS_PORT`, `TMPDIR`, and `COMPOSE_PROJECT_NAME` to reduce port/service-name collisions.
- The Docker image/build context excludes `keys.txt`, `.env*`, `node_modules`, `dist`, and `.git`.
- `.symphony` is orchestrator-owned runtime wiring. Workers are instructed not to inspect it, print it, or commit it.

The configured `runtime.docker.codex_home` path is used only as an auth source. Symphony copies `auth.json` into an ephemeral per-run temp directory, mounts that minimal copy read-write into the worker container, and deletes it during runtime cleanup. It intentionally does not copy Codex plugin caches, marketplace config, app approvals, rollout state, or shell history, so workers do not inherit ambient Linear/GitHub/Vercel tools from the operator environment. Use a dedicated low-privilege Codex account/home for production factory runs. For a more restrictive deployment, also set stricter Codex `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` values in `WORKFLOW.md`, and run Symphony itself under a dedicated OS/container/VM boundary with limited credentials.

## Observability

Structured logs are written as stable `key=value` lines. Issue logs include `issue_id` and `issue_identifier`; session lifecycle logs include `session_id` when available.

When the HTTP extension is enabled:

- `GET /` returns a human-readable dashboard.
- `GET /api/v1/state` returns running sessions, retry queue, token/runtime totals, and rate limits.
- `GET /api/v1/<issue_identifier>` returns issue-specific debug state.
- `POST /api/v1/refresh` queues an immediate poll/reconcile tick.
- `linear_graphql_mcp_configured`, `linear_graphql_bridge_started`, and `linear_graphql_tool_call` events show whether the Symphony-owned Linear tool was configured, had a live runtime-reachable MCP bridge, and was used by a worker. Tracker secret values and MCP bearer tokens are redacted before event payloads are recorded.

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
- `SAM-69`, `Validate Symphony Linear MCP loopback bridge`: real Codex cloned `origin/main` at `b386877867bc0a49a7cff830a0eb758c07e1a1d8`, discovered the generated `symphony_linear` MCP server, accepted MCP elicitation with the required shape, used `linear_graphql` through the loopback bridge for Linear reads/comment/state transition, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_LINEAR_GRAPHQL_BRIDGE_RESULT.md` locally in the per-issue workspace, added the handoff comment, and moved the issue to `Needs Human`.
- `SAM-70`, `Validate hosted Symphony Linear MCP hardening`: real Codex cloned `origin/main` at `cdff48f5905c622c423b1f36673a56179c588b29`, discovered the hosted Streamable HTTP `symphony_linear` MCP server, used `linear_graphql` for Linear reads/comment/state transition, verified there was no workspace `.symphony/linear-graphql-mcp.mjs` or `linear-graphql-mcp.mjs` file outside `node_modules`, confirmed app-server argv/config used `mcp_servers.symphony_linear.url` without a Linear API key or bridge token marker, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_HOSTED_MCP_RESULT.md` locally in the per-issue workspace, added the handoff comment, and moved the issue to `Needs Human`.

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

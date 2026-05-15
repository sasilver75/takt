# Operations

## Running

```bash
LINEAR_API_KEY=... pnpm dev ./WORKFLOW.md --port 8787
```

The positional argument selects the workflow file. If omitted, Symphony uses `./WORKFLOW.md`.

`--port` enables the optional HTTP status surface and overrides `server.port` from workflow front matter. The server binds loopback by default.

## Workflow Reload

The service watches `WORKFLOW.md` and reloads config and prompt content without restart. Reloaded settings apply to future dispatch, retries, hooks, reconciliation, and agent launches. In-flight Codex sessions are not restarted just because config changed.

If reload fails, Symphony logs `workflow reload failed` and keeps using the last known good config.

## Safety Posture

This implementation uses a high-trust default posture suitable for trusted local automation:

- Codex command execution and file-change approval requests are auto-approved for the session.
- Codex user-input requests are not allowed to stall indefinitely; the client returns an empty response and records `turn_input_required`.
- Workspace isolation is filesystem-scoped: every agent subprocess is launched in the per-issue workspace and workspace paths must remain under `workspace.root`.
- Hook scripts are trusted repository configuration and run in the workspace directory with `hooks.timeout_ms`.
- Linear credentials are resolved from workflow config/env indirection and are redacted from logs.

For a more restrictive deployment, set stricter Codex `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` values in `WORKFLOW.md`, and run Symphony under a dedicated OS/container/VM boundary with limited credentials.

## Observability

Structured logs are written as stable `key=value` lines. Issue logs include `issue_id` and `issue_identifier`; session lifecycle logs include `session_id` when available.

When the HTTP extension is enabled:

- `GET /` returns a human-readable dashboard.
- `GET /api/v1/state` returns running sessions, retry queue, token/runtime totals, and rate limits.
- `GET /api/v1/<issue_identifier>` returns issue-specific debug state.
- `POST /api/v1/refresh` queues an immediate poll/reconcile tick.

## Real Integration

The deterministic Vitest suite uses fake Linear/local tracker and fake Codex app-server harnesses. `pnpm test:factory` is the highest-signal local check: it copies `examples/toy-webapp` into an isolated workspace, lets a scripted app-server modify backend and frontend TypeScript, handles tool/approval requests, compiles the resulting app, and validates handoff status.

Live Linear/Codex checks are intentionally not run by default because they require credentials, network access, and permission to execute real issue work.

Before production use:

- Run a real Linear smoke test against an isolated project.
- Run Codex against a disposable issue/workspace.
- Verify hooks on the target host shell.
- Confirm the chosen approval/sandbox policy matches the risk profile.

## Verification Commands

- `pnpm typecheck`: typechecks the Symphony service.
- `pnpm test`: runs unit and deterministic integration tests.
- `pnpm test:factory`: runs only the toy web-app production-factory harness.
- `pnpm toy:typecheck`: typechecks the toy frontend/backend fixture.
- `pnpm verify`: runs the full local gate used by CI.

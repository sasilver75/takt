# SAM-71 Live Docker Runtime Validation

Date: 2026-05-15 UTC

## Summary

Validated the Docker-first Symphony worker runtime from inside the live worker workspace.

## Evidence

- Repository commit: `483104c` (`483104c Add Docker worker runtime`). `git merge-base --is-ancestor 483104c HEAD` returned success, so the checkout is at the expected commit or newer.
- Runtime workspace: `SYMPHONY_RUNTIME_WORKSPACE=/workspace`.
- Docker runtime evidence: `/.dockerenv` exists in this worker and the runtime workspace is `/workspace`.
- Codex app-server cwd: live `codex app-server` processes had cwd `/workspace`.
- App-server argv: live argv uses `mcp_servers.symphony_linear.url=<url>` and `mcp_servers.symphony_linear.bearer_token_env_var=<env-var-ref>`; no raw Linear API key or bearer token value was present in argv.
- Linear MCP: `linear_graphql` was available via the `symphony_linear` MCP server and was used to read Linear issue `SAM-71`.
- Required runtime env keys were present: `SYMPHONY_PORT_BASE`, `PORT`, `APP_PORT`, `VITE_PORT`, `DATABASE_PORT`, `REDIS_PORT`, `COMPOSE_PROJECT_NAME`, and `SYMPHONY_RUNTIME_WORKSPACE`.
- Workspace secret checks:
  - `find /workspace -name keys.txt` found `0` files.
  - Repository scan for raw Linear API key literals matching `lin_api_[A-Za-z0-9_-]+` found `0` matches outside `node_modules`/`.git`.
  - App-server argv raw Linear key check: `no`.
  - App-server argv bearer-token-value check: `no`; argv uses `bearer_token_env_var` instead.

## Verification

- `pnpm typecheck` passed.
- `pnpm test` passed: 10 test files passed, 28 tests passed.

## Conclusion

Acceptance criteria for Docker-first Symphony worker runtime validation are satisfied. This evidence file was committed locally from the issue workspace for handoff.

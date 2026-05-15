# Symphony TypeScript Orchestrator

This repository implements the Symphony specification in [SPEC.md](./SPEC.md): a long-running service that polls Linear, creates one workspace per issue, and runs Codex app-server sessions inside those workspaces.

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev ./examples/WORKFLOW.md --port 0
```

Production workflows should keep secrets in environment variables and refer to them from `WORKFLOW.md`, for example `api_key: $LINEAR_API_KEY`. The service validates that credentials exist without printing them.

## Main Pieces

- `src/workflow`: `WORKFLOW.md` discovery, YAML front matter parsing, hot reload, strict Liquid prompt rendering.
- `src/config`: typed config defaults, env indirection, validation, state normalization.
- `src/tracker`: Linear GraphQL adapter and `linear_graphql` tool backend.
- `src/workspace`: sanitized workspace paths, containment checks, lifecycle hooks.
- `src/agent`: Codex app-server JSON-line client and agent runner.
- `src/orchestrator`: polling, dispatch, reconciliation, retries, token/rate-limit accounting.
- `src/http`: optional dashboard and `/api/v1/*` status/control endpoints.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/OPERATIONS.md](./docs/OPERATIONS.md) for operating details and safety posture.

## Implementation Notes

The generated Codex protocol schemas and TypeScript bindings live under `schema/codex-app-server` and `src/codex/generated`. They are treated as local protocol reference artifacts. The runtime client uses the current app-server JSON-RPC line framing and sends `initialize`, `thread/start`, and `turn/start` requests with workspace-scoped `cwd`.

The implementation follows the agent-first harness guidance in OpenAI’s harness engineering article and Symphony announcement: repository-local knowledge is the system of record, observability is exposed to agents/operators, and the workflow prompt remains versioned with the target repo.

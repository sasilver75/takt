# Symphony TypeScript Orchestrator

This repository implements the Symphony specification in [SPEC.md](./SPEC.md): a long-running service that polls Linear, creates one workspace per issue, and runs Codex app-server sessions inside those workspaces.

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:factory
pnpm build
pnpm verify
docker build -f docker/codex-worker.Dockerfile -t symphony-codex-worker:latest .
pnpm dev ./examples/WORKFLOW.md --port 0
```

Production workflows should keep secrets in environment variables and refer to them from `WORKFLOW.md`, for example `api_key: $LINEAR_API_KEY`. The service validates that credentials exist without printing them.

## Main Pieces

- `src/workflow`: `WORKFLOW.md` discovery, YAML front matter parsing, hot reload, strict Liquid prompt rendering.
- `src/config`: typed config defaults, env indirection, validation, state normalization.
- `src/tracker`: Linear GraphQL adapter and `linear_graphql` tool backend.
- `src/workspace`: sanitized workspace paths, containment checks, lifecycle hooks.
- `src/runtime`: first-class Docker worker runtime with host fallback for local tests/debugging.
- `src/agent`: Codex app-server JSON-line client, hosted `symphony_linear` MCP bridge, and agent runner.
- `src/orchestrator`: polling, dispatch, reconciliation, retries, token/rate-limit accounting.
- `src/http`: optional dashboard and `/api/v1/*` status/control endpoints.
- `examples/toy-webapp`: frontend/backend TypeScript fixture used to exercise Symphony as a web-app production factory.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/OPERATIONS.md](./docs/OPERATIONS.md) for operating details and safety posture.

## Implementation Notes

The generated Codex protocol schemas and TypeScript bindings live under `schema/codex-app-server` and `src/codex/generated`. They are treated as local protocol reference artifacts. The runtime client uses the current app-server JSON-RPC line framing and sends `initialize`, `thread/start`, and `turn/start` requests with runtime-scoped `cwd`.

The implementation follows the agent-first harness guidance in OpenAI’s [harness engineering article](https://openai.com/index/harness-engineering/) and [Symphony announcement](https://openai.com/index/open-source-codex-orchestration-symphony/): repository-local knowledge is the system of record, observability is exposed to agents/operators, and the workflow prompt remains versioned with the target repo. Worker sessions run Codex app-server inside a per-issue Docker container by default, with the workspace mounted at `/workspace`, an ephemeral minimal Codex home containing auth material, and no repo root or `keys.txt` mount. They get a Symphony-owned `linear_graphql` MCP tool backed by a short-lived authenticated Streamable HTTP MCP server, so Linear handoff is portable and auditable rather than dependent on globally installed Codex plugins or worker-visible Linear credentials. Tracker secrets are scrubbed from the Codex app-server environment and redacted from Symphony logs.

## Factory Harness

`pnpm test:factory` runs a deterministic end-to-end production-factory scenario:

1. Creates an isolated workspace from `examples/toy-webapp`.
2. Runs a scripted Codex app-server over JSON lines.
3. Handles approval and `linear_graphql` tool requests.
4. Modifies both backend and frontend TypeScript.
5. Verifies the changed app with `tsc` from outside the repo tree.
6. Confirms Symphony status snapshots show handoff/completion state.

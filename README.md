# Takt

Takt is a TypeScript software factory runtime originating from the Symphony specification in [SPEC.md](./SPEC.md). It polls Linear, creates one isolated workspace per issue, runs Codex app-server sessions inside those workspaces, and turns completed worker output into reviewable GitHub PRs.

## Quick Start

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:factory
pnpm build
pnpm verify
pnpm integration:live
docker build -f docker/codex-worker.Dockerfile -t takt-codex-worker:latest .
docker build -f docker/codex-worker-go.Dockerfile -t takt-codex-worker-go:latest .
pnpm dev validate ./examples/WORKFLOW.md
pnpm dev ./examples/WORKFLOW.md --reconcile-once
pnpm dev ./examples/WORKFLOW.md --port 0
```

Production workflows should keep secrets in environment variables and refer to them from `WORKFLOW.md`, for example `api_key: $LINEAR_API_KEY`. The service validates that credentials exist without printing them.

## Target Application Contract

Takt is reusable across applications by changing the workflow contract, not by teaching the orchestrator every stack. A single Takt instance is expected to target one application/repository at a time; Linear, GitHub, Codex app-server, Docker or host runtimes, and Chromium remain the fixed delivery-loop assumptions.

`WORKFLOW.md` front matter now supports an optional `target` section with descriptive metadata such as `name`, `kind`, `repository`, `instructions`, `verification`, `evidence`, and `handoff`. Takt exposes that data to the worker prompt as `target`, while hooks, worker images, and repo-local docs remain responsible for stack-specific setup. See [docs/WORKFLOW_CONTRACT.md](./docs/WORKFLOW_CONTRACT.md) and templates under [examples/workflows](./examples/workflows).

Run `takt validate ./WORKFLOW.md` or `takt doctor ./WORKFLOW.md` before starting a new target. The validator is non-mutating and checks config, required environment variables, target metadata, Linear/GitHub coherence, runtime/image readiness, hooks, and sample prompt rendering.

## Main Pieces

- `src/workflow`: `WORKFLOW.md` discovery, YAML front matter parsing, hot reload, strict Liquid prompt rendering.
- `src/config`: typed config defaults, env indirection, validation, state normalization.
- `src/tracker`: Linear GraphQL adapter and `linear_graphql` tool backend.
- `src/github`: orchestrator-owned branch push, GitHub PR creation/update, lifecycle inspection, evidence comments, and optional policy-gated merging.
- `src/workspace`: sanitized workspace paths, containment checks, lifecycle hooks.
- `src/runtime`: first-class Docker worker runtime with host fallback for local tests/debugging.
- `src/agent`: Codex app-server JSON-line client, hosted `takt_linear` MCP bridge, and agent runner.
- `src/orchestrator`: polling, dispatch explainability, reconciliation, retries, token/rate-limit accounting.
- `src/persistence`: durable JSON state snapshots for retry/history recovery across process restarts.
- `src/http`: optional dashboard and `/api/v1/*` status/control endpoints.
- `examples/toy-webapp`: frontend/backend TypeScript fixture used to exercise Takt as a web-app production factory.

See [docs/TAKT_PRODUCT_CONTRACT.md](./docs/TAKT_PRODUCT_CONTRACT.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), and [docs/OPERATIONS.md](./docs/OPERATIONS.md) for the concrete product contract, operating details, and safety posture.

## Implementation Notes

The generated Codex protocol schemas and TypeScript bindings live under `schema/codex-app-server` and `src/codex/generated`. They are treated as local protocol reference artifacts. The runtime client uses the current app-server JSON-RPC line framing and sends `initialize`, `thread/start`, and `turn/start` requests with runtime-scoped `cwd`.

The implementation follows the agent-first harness guidance in OpenAI’s [harness engineering article](https://openai.com/index/harness-engineering/) and [Symphony announcement](https://openai.com/index/open-source-codex-orchestration-symphony/): repository-local knowledge is the system of record, observability is exposed to agents/operators, and the workflow prompt remains versioned with the target repo. Worker sessions run Codex app-server inside a per-issue Docker container by default, with the workspace mounted at `/workspace`, an ephemeral minimal Codex home containing auth material, and no repo root or `keys.txt` mount. They get a Takt-owned `linear_graphql` MCP tool backed by a short-lived authenticated Streamable HTTP MCP server, so Linear reads are portable and auditable rather than dependent on globally installed Codex plugins or worker-visible Linear credentials. Tracker and GitHub secrets are scrubbed from the Codex app-server environment and redacted from Takt logs.

When `github.enabled` is configured, workers commit their code and signal PR readiness with `TAKT_PR_READY.json`; Takt then pushes the issue branch, creates or updates the GitHub PR, comments the PR link in Linear, and moves the issue to the configured review state. Workers may also write `TAKT_EVIDENCE.json` with app URLs, verification commands, screenshots, traces, logs, or other artifact paths; Takt publishes that as a sticky PR comment. The orchestrator keeps inspecting the PR after publication: managed open PRs are rediscovered after restart, a bounded closed/merged PR scan catches human merges that happened while Takt was offline, passing or pending checks remain in human review, merged/closed PRs are recorded as terminal, and failing checks, top-level PR comments, review comments, or unresolved review threads requeue the issue with a focused follow-up prompt. If `github.merge.enabled` is explicitly turned on, Takt can merge non-draft PRs whose inspected head SHA satisfies the configured approval/check/mergeability policy and then move the issue to `github.merge.complete_state`; the same completion-state transition is also applied when Takt observes a human-merged managed PR. GitHub credentials stay in the orchestrator process and are not mounted into worker containers.

Restart-meaningful orchestration state is persisted under `workspace.root/.takt/state.json`: retry entries, completed issue IDs, issue history, recent events, token totals, and PR metadata. Live worker processes are not resumed after restart; Takt restores metadata and reconciles Linear/GitHub before dispatching fresh attempts.

## Factory Harness

`pnpm test:factory` runs a deterministic end-to-end production-factory scenario:

1. Creates an isolated workspace from `examples/toy-webapp`.
2. Runs a scripted Codex app-server over JSON lines.
3. Handles approval and `linear_graphql` tool requests.
4. Modifies both backend and frontend TypeScript.
5. Verifies the changed app with `tsc` from outside the repo tree.
6. Confirms Takt status snapshots show handoff/completion state.

`pnpm integration:live` is the explicit real-integration profile. It reports `SKIP` unless
`TAKT_LIVE_INTEGRATION=1` is set. When enabled, it performs non-mutating live checks: workflow
load, dispatch config validation, Linear candidate read, and GitHub repository metadata read when
`github.enabled` is true.

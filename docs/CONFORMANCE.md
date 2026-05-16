# Symphony Conformance Map

This map ties `SPEC.md` required and shipped-extension behavior to implementation files and deterministic checks. It is intentionally evidence-oriented: update it when a feature moves, a test is added, or an extension is retired.

## Core Conformance

| Spec area | Implementation evidence | Test evidence |
| --- | --- | --- |
| Workflow path selection and default `./WORKFLOW.md` | `src/workflow/loader.ts`, `src/cli.ts` | `src/workflow/workflow_config.test.ts` |
| YAML front matter and prompt-body split | `src/workflow/loader.ts` | `src/workflow/workflow_config.test.ts` |
| Typed config defaults, `$VAR` resolution, path expansion | `src/config/config.ts` | `src/workflow/workflow_config.test.ts` |
| Dynamic workflow watch/reload with last-good config | `src/workflow/runtime.ts`, `src/orchestrator/orchestrator.ts` | `src/workflow/workflow_config.test.ts` |
| Single-authority polling orchestrator state | `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts` |
| Linear candidate fetch, terminal fetch, state refresh | `src/tracker/linear.ts` | `src/tracker/linear.test.ts` |
| Sanitized, contained per-issue workspaces | `src/workspace/manager.ts` | `src/workspace/manager.test.ts` |
| Workspace lifecycle hooks and timeouts | `src/workspace/manager.ts`, `src/runtime/workerRuntime.ts` | `src/workspace/manager.test.ts`, `src/runtime/workerRuntime.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Codex app-server JSON-line client | `src/agent/codexClient.ts` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Configurable Codex launch command | `src/config/config.ts`, `src/runtime/workerRuntime.ts`, `src/agent/codexClient.ts` | `src/workflow/workflow_config.test.ts`, `src/agent/runner.test.ts` |
| Strict prompt rendering with issue/attempt/follow-up context | `src/workflow/prompt.ts` | `src/workflow/workflow_config.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Retry queue, continuation retries, exponential backoff cap | `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts` |
| Active-run reconciliation and terminal cleanup | `src/orchestrator/orchestrator.ts`, `src/workspace/manager.ts` | `src/orchestrator/orchestrator.test.ts` |
| Structured issue/session logging and runtime snapshots | `src/observability/logger.ts`, `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Approval/user-input policy does not stall | `src/agent/codexClient.ts`, `docs/OPERATIONS.md` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |

## Shipped Extensions

| Extension | Implementation evidence | Test / validation evidence |
| --- | --- | --- |
| HTTP dashboard and JSON API | `src/http/server.ts`, `src/service.ts` | `src/http/server.test.ts` |
| Hosted `linear_graphql` MCP bridge | `src/agent/linearGraphqlBridge.ts`, `src/agent/linearGraphqlMcp.ts`, `src/tracker/linear.ts` | `src/agent/linearGraphqlBridge.test.ts`, `src/agent/linearGraphqlMcp.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Durable state | `src/persistence/jsonStateStore.ts`, `src/orchestrator/orchestrator.ts` | `src/persistence/jsonStateStore.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| GitHub PR publishing and lifecycle reconciliation | `src/github/publisher.ts`, `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/publisher.test.ts`, `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Worker evidence manifest and sticky PR evidence comment | `src/github/evidence.ts`, `src/orchestrator/orchestrator.ts` | `src/github/evidence.test.ts`, `src/orchestrator/orchestrator.test.ts`, live PRs `#3` and `#4` |
| Policy-gated GitHub merge extension | `src/github/merger.ts`, `src/orchestrator/orchestrator.ts` | `src/github/merger.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Docker-first worker runtime | `src/runtime/workerRuntime.ts`, `docker/codex-worker.Dockerfile`, `docs/OPERATIONS.md` | `src/runtime/workerRuntime.test.ts`, live `SAM-71` run |
| PR follow-up from checks/comments/reviews/threads | `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts`, live PR `#3` |

## Operational Validation

- Local deterministic gate: `pnpm verify`.
- App-shaped factory harness: `pnpm test:factory`.
- Live Linear/Codex/Docker history: `docs/OPERATIONS.md`.
- Latest live PR loop evidence: PR `#4`, sticky evidence comment `#issuecomment-4467788558`.

## Known Gaps And Watch Items

- Real integration checks are operator-run, not automatic CI gates, because they mutate Linear/GitHub and require live credentials.
- The HTTP dashboard is functional and state-backed, but intentionally minimal; richer drill-down history and artifact browsing remain product work.
- Workers can attach durable artifacts through committed files and evidence manifests, and Symphony warns when listed artifact paths are missing or not tracked. Large binary artifact retention, external object storage, video capture conventions, and trace viewers are not yet first-class orchestration features.
- The spec's SSH worker appendix is not implemented; Docker is the first-class isolation runtime.

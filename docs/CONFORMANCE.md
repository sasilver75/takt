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
| Codex app-server JSON-line client, same-thread continuation turns, timeout classification, and unsupported tool failures | `src/agent/codexClient.ts`, `src/agent/runner.ts` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Configurable Codex launch command | `src/config/config.ts`, `src/runtime/workerRuntime.ts`, `src/agent/codexClient.ts` | `src/workflow/workflow_config.test.ts`, `src/agent/runner.test.ts` |
| Strict prompt rendering with issue/attempt/follow-up context | `src/workflow/prompt.ts` | `src/workflow/workflow_config.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Retry queue, continuation retries, slot-exhaustion requeue, exponential backoff cap | `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts` |
| Active-run reconciliation and terminal cleanup | `src/orchestrator/orchestrator.ts`, `src/workspace/manager.ts` | `src/orchestrator/orchestrator.test.ts` |
| Structured issue/session logging, token/rate-limit accounting, and runtime snapshots | `src/observability/logger.ts`, `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Approval/user-input policy does not stall | `src/agent/codexClient.ts`, `docs/OPERATIONS.md` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| CLI workflow path, port override, reconcile-once mode, and startup failure surfacing | `src/cli.ts`, `src/service.ts` | `src/cli.test.ts`, `src/orchestrator/orchestrator.test.ts` |

## Shipped Extensions

| Extension | Implementation evidence | Test / validation evidence |
| --- | --- | --- |
| HTTP dashboard, issue drill-down pages, and JSON API | `src/http/server.ts`, `src/service.ts` | `src/http/server.test.ts` |
| Hosted `linear_graphql` MCP bridge | `src/agent/linearGraphqlBridge.ts`, `src/agent/linearGraphqlMcp.ts`, `src/tracker/linear.ts` | `src/agent/linearGraphqlBridge.test.ts`, `src/agent/linearGraphqlMcp.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Durable state | `src/persistence/jsonStateStore.ts`, `src/orchestrator/orchestrator.ts` | `src/persistence/jsonStateStore.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| GitHub PR publishing, handoff-manifest hygiene, lifecycle reconciliation, and human-merge recovery | `src/github/publisher.ts`, `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/publisher.test.ts`, `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Worker evidence manifest, bounded artifact auto-publishing, sticky PR evidence comment, persisted artifact warnings, and dashboard/API evidence summary | `src/github/evidence.ts`, `src/github/evidenceArtifacts.ts`, `src/orchestrator/orchestrator.ts`, `src/http/server.ts` | `src/github/evidence.test.ts`, `src/github/publisher.test.ts`, `src/orchestrator/orchestrator.test.ts`, `src/http/server.test.ts`, live PRs `#3`, `#4`, and `#5` |
| Policy-gated GitHub merge extension | `src/github/merger.ts`, `src/orchestrator/orchestrator.ts` | `src/github/merger.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Docker-first worker runtime | `src/runtime/workerRuntime.ts`, `docker/codex-worker.Dockerfile`, `docs/OPERATIONS.md` | `src/runtime/workerRuntime.test.ts`, live `SAM-71` run |
| PR follow-up from checks/comments/reviews/threads | `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts`, live PR `#3` |
| Skip-visible real integration profile | `src/integration/liveProfile.ts`, `package.json`, `docs/OPERATIONS.md` | `src/integration/liveProfile.test.ts`; `pnpm integration:live` reports `SKIP` unless explicitly enabled |

## Operational Validation

- Local deterministic gate: `pnpm verify`.
- App-shaped factory harness: `pnpm test:factory`.
- Non-mutating live readiness profile: `pnpm integration:live`, explicitly enabled with `SYMPHONY_LIVE_INTEGRATION=1`.
- Live Linear/Codex/Docker history: `docs/OPERATIONS.md`.
- Latest live PR loop evidence: PR `#5`, sticky evidence comment `#issuecomment-4468087596`.

## Known Gaps And Watch Items

- Mutating full-loop real integration checks are operator-run, not automatic CI gates, because they touch Linear/GitHub and require live credentials. A non-mutating readiness profile exists and reports skipped status unless explicitly enabled.
- The HTTP dashboard is functional and state-backed, including per-issue drill-down pages; richer long-term run history, full artifact browsing, and external artifact retention remain product work.
- Workers can attach durable artifacts through committed files, or by listing small workspace-contained files/directories under `artifacts/` in the evidence manifest so Symphony uploads them to the PR branch. Large binary artifact retention, external object storage, video capture conventions, and trace viewers are not yet first-class orchestration features.
- The spec's SSH worker appendix is not implemented; Docker is the first-class isolation runtime.

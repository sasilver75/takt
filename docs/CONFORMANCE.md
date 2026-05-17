# Takt Conformance Map

This map ties `SPEC.md` required and shipped-extension behavior to implementation files and deterministic checks. It is intentionally evidence-oriented: update it when a feature moves, a test is added, or an extension is retired.

## Core Conformance

| Spec area | Implementation evidence | Test evidence |
| --- | --- | --- |
| Workflow path selection and default `./WORKFLOW.md` | `src/workflow/loader.ts`, `src/cli.ts` | `src/workflow/workflow_config.test.ts` |
| YAML front matter and prompt-body split | `src/workflow/loader.ts` | `src/workflow/workflow_config.test.ts` |
| Typed config defaults, `$VAR` resolution, path expansion | `src/config/config.ts` | `src/workflow/workflow_config.test.ts` |
| Target application metadata and concrete Takt product contract exposed without stack-specific scheduler branching | `src/config/config.ts`, `src/workflow/prompt.ts`, `src/agent/codexClient.ts`, `docs/WORKFLOW_CONTRACT.md`, `docs/TAKT_PRODUCT_CONTRACT.md`, `examples/workflows/*` | `src/workflow/workflow_config.test.ts` |
| Scenario matrix distinguishes workflow-only templates from runnable regression fixtures | `examples/README.md`, `examples/workflows/README.md`, `docs/WORKFLOW_CONTRACT.md`, `examples/toy-webapp`, `examples/toy-go-service`, `examples/toy-node-cli` | `src/workflow/workflow_config.test.ts`, `src/harness/toyWebappFactory.test.ts`, `src/harness/runnableFixtures.test.ts` |
| Dynamic workflow watch/reload with last-good config | `src/workflow/runtime.ts`, `src/orchestrator/orchestrator.ts` | `src/workflow/workflow_config.test.ts` |
| Single-authority polling orchestrator state, completed bookkeeping, explicit PR-handoff dispatch suppression, and candidate dispatch-decision explainability | `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts` |
| Linear candidate fetch, terminal fetch, state refresh | `src/tracker/linear.ts` | `src/tracker/linear.test.ts` |
| Orchestrator-owned Linear state transitions and comments | `src/tracker/linear.ts`, `src/orchestrator/orchestrator.ts` | `src/tracker/linear.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Sanitized, contained per-issue workspaces | `src/workspace/manager.ts` | `src/workspace/manager.test.ts` |
| Workspace lifecycle hooks and timeouts | `src/workspace/manager.ts`, `src/runtime/workerRuntime.ts` | `src/workspace/manager.test.ts`, `src/runtime/workerRuntime.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Codex app-server JSON-line client, same-thread continuation turns, timeout classification, and unsupported tool failures | `src/agent/codexClient.ts`, `src/agent/runner.ts` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Configurable Codex launch command | `src/config/config.ts`, `src/runtime/workerRuntime.ts`, `src/agent/codexClient.ts` | `src/workflow/workflow_config.test.ts`, `src/agent/runner.test.ts` |
| Strict prompt rendering with issue/attempt/follow-up context | `src/workflow/prompt.ts` | `src/workflow/workflow_config.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Retry queue, continuation retries, slot-exhaustion requeue, exponential backoff cap | `src/orchestrator/orchestrator.ts` | `src/orchestrator/orchestrator.test.ts` |
| Active-run reconciliation and terminal cleanup | `src/orchestrator/orchestrator.ts`, `src/workspace/manager.ts` | `src/orchestrator/orchestrator.test.ts` |
| Structured issue/session logging, token/rate-limit accounting, runtime snapshots, and configurable bounded per-issue run-attempt history | `src/observability/logger.ts`, `src/config/config.ts`, `src/orchestrator/orchestrator.ts` | `src/workflow/workflow_config.test.ts`, `src/orchestrator/orchestrator.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Approval/user-input policy does not stall | `src/agent/codexClient.ts`, `docs/OPERATIONS.md` | `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| CLI workflow path, port override, reconcile-once mode, and startup failure surfacing | `src/cli.ts`, `src/service.ts` | `src/cli.test.ts`, `src/orchestrator/orchestrator.test.ts` |

## Shipped Extensions

| Extension | Implementation evidence | Test / validation evidence |
| --- | --- | --- |
| HTTP dashboard, issue drill-down pages with dispatch decisions and run-attempt history, and JSON API | `src/http/server.ts`, `src/service.ts` | `src/http/server.test.ts` |
| Hosted `linear_graphql` MCP bridge, guarded dynamic-tool fallback, and secret redaction in tool payloads | `src/agent/linearGraphqlBridge.ts`, `src/agent/linearGraphqlMcp.ts`, `src/agent/codexClient.ts`, `src/tracker/linear.ts` | `src/agent/linearGraphqlBridge.test.ts`, `src/agent/linearGraphqlMcp.test.ts`, `src/agent/runner.test.ts`, `src/harness/toyWebappFactory.test.ts` |
| Durable state | `src/persistence/jsonStateStore.ts`, `src/orchestrator/orchestrator.ts` | `src/persistence/jsonStateStore.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| GitHub PR publishing, durable publication transaction checkpoints, idempotent PR-link tracker comments, strict PR-ready handoff-manifest validation, lifecycle reconciliation, and human-merge recovery | `src/github/publisher.ts`, `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/publisher.test.ts`, `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Worker evidence manifest validation, separated verification/check command metadata, bounded artifact auto-publishing with visible truncation warnings, sticky PR evidence comment with inline image previews, persisted artifact warnings, dashboard/API evidence summary, and local artifact browsing with scan warnings | `src/github/evidence.ts`, `src/github/evidenceArtifacts.ts`, `src/orchestrator/orchestrator.ts`, `src/http/server.ts` | `src/github/evidence.test.ts`, `src/github/publisher.test.ts`, `src/orchestrator/orchestrator.test.ts`, `src/http/server.test.ts`, live PRs `#3`, `#4`, `#5`, and `#6` |
| Policy-gated GitHub merge extension | `src/github/merger.ts`, `src/orchestrator/orchestrator.ts` | `src/github/merger.test.ts`, `src/orchestrator/orchestrator.test.ts` |
| Docker-first worker runtime with baseline Chromium screenshot capability | `src/runtime/workerRuntime.ts`, `docker/codex-worker.Dockerfile`, `docker/takt-capture-url`, `docs/OPERATIONS.md` | `src/runtime/workerRuntime.test.ts`, `src/runtime/dockerImage.test.ts`, live `SAM-71` run |
| Target readiness validator / doctor command | `src/validation/doctor.ts`, `src/cli.ts`, `docs/WORKFLOW_CONTRACT.md`, `examples/workflows/README.md` | `src/validation/doctor.test.ts`, `src/cli.test.ts` |
| PR follow-up from checks/comments/current-head reviews/current-head threads, with stale-head suppression on recovered PRs | `src/github/tracker.ts`, `src/orchestrator/orchestrator.ts` | `src/github/tracker.test.ts`, `src/orchestrator/orchestrator.test.ts`, live PR `#3` |
| Skip-visible real integration profile and gated mutating publication-ledger canary matrix | `src/integration/liveProfile.ts`, `src/integration/livePublicationCanary.ts`, `package.json`, `docs/OPERATIONS.md` | `src/integration/liveProfile.test.ts`, `src/integration/livePublicationCanary.test.ts`; `pnpm integration:live` reports `SKIP` unless explicitly enabled; live `SAM-101`-`SAM-107` / PR `#17`-`#23` publication canary matrix |

## Operational Validation

- Local deterministic gate: `pnpm verify`.
- Target onboarding gate: `LINEAR_API_KEY=... GITHUB_TOKEN=... takt validate ./WORKFLOW.md`.
- App-shaped factory harness: `pnpm test:fixtures`.
- Standalone toy fixture checks: `pnpm toy:go:test`, `pnpm toy:cli:test`, and `pnpm toy:typecheck`.
- Non-mutating live readiness profile: `pnpm integration:live`, explicitly enabled with `TAKT_LIVE_INTEGRATION=1`.
- Live Linear/Codex/Docker history: `docs/OPERATIONS.md`.
- Latest live PR loop evidence: PR `#6`, sticky evidence comment `#issuecomment-4468480674`.

## Known Gaps And Watch Items

- `IMPLEMENTED`: One-application target contracts are represented by typed `target` workflow metadata, reusable workflow templates, `docs/TAKT_PRODUCT_CONTRACT.md`, and the non-mutating `validate`/`doctor` command.
- `IMPLEMENTED`: Workflow templates are parsed as copy/customize contracts, while `toy-webapp`, `toy-go-service`, and `toy-node-cli` are runnable regression fixtures driven through the scripted Codex app-server harness.
- `IMPLEMENTED`: TypeScript/web, Go service, and no-server Node CLI profiles are documented; the default image covers Node/Chromium and `docker/codex-worker-go.Dockerfile` adds Go tooling.
- `IMPLEMENTED`: Scenario overlays now cover malformed evidence manifests, incomplete PR-ready manifests, prompt-render failures, hook failures, dispatch validation failures, candidate-fetch failures, and validator failures on top of the existing fixture matrix.
- `INTENTIONALLY DEFERRED`: Richer evidence publishing should grow over time on top of the current fixture matrix rather than by adding more app stacks first.
- `ACCEPTED GAP`: The readiness validator checks local Docker image presence and config coherence but intentionally avoids live Linear/GitHub/API calls; `pnpm integration:live` remains the non-mutating live readiness profile.
- `INTENTIONALLY DEFERRED`: Generic tracker/SCM adapters remain out of scope for the current product direction. Linear and GitHub stay fixed assumptions.
- Mutating full-loop real integration checks are operator-run, not automatic CI gates, because they touch Linear/GitHub and require live credentials. A non-mutating readiness profile exists and reports skipped status unless explicitly enabled.
- The HTTP dashboard is functional and state-backed, including per-issue drill-down pages, bounded worker run-attempt history, and local browsing for evidence-manifest artifacts under `artifacts/`; external artifact retention and cross-run analytics remain product work.
- Workers can attach durable artifacts through committed files, or by listing small workspace-contained files/directories under `artifacts/` in the evidence manifest so Takt uploads them to the PR branch. The evidence manifest distinguishes successful verification checks from supporting launch/capture/export commands, but large binary artifact retention, external object storage, video capture conventions, and trace viewers are not yet first-class orchestration features.
- The spec's SSH worker appendix is not implemented; Docker is the first-class isolation runtime.

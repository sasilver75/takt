# Takt Product Contract

Takt is the opinionated production-factory implementation that grew out of the broader Symphony
specification in `SPEC.md`. `SPEC.md` remains the generic orchestration reference. This document is
the concrete product contract for this repository.

## Fixed Delivery Loop

A Takt instance owns one target application or repository at a time. The workflow is:

1. Read candidate work from a configured Linear project.
2. Claim eligible issues before worker launch when `tracker.claim_state` is configured.
3. Create or reuse a sanitized per-issue workspace under `workspace.root`.
4. Run Codex app-server inside the selected worker runtime, Docker-first by default.
5. Let the worker implement, verify, commit, and write handoff manifests.
6. Publish or update a GitHub PR from orchestrator-held credentials.
7. Publish reviewer evidence when the worker provides it.
8. Move Linear to review or completion states according to workflow config.
9. Reconcile GitHub checks, reviews, comments, unresolved threads, and human merges.
10. Requeue worker follow-up when current PR feedback requires more work.

Linear, GitHub, Codex app-server, Docker or host runtimes, and the HTTP status surface are product
assumptions for Takt. Generic tracker and SCM adapters are not part of the current contract.

## Repository Contract

The target repository controls runtime policy through `WORKFLOW.md`:

- `target` describes the application for prompts and operators.
- `tracker` selects Linear project, active states, terminal states, claim state, and review state.
- `github` configures PR publication, branch naming, evidence files, and optional merge policy.
- `runtime` and `hooks` define how each issue workspace is populated and prepared.
- `agent` and `codex` configure worker limits, timeouts, approval policy, sandbox policy, and MCP
  tooling.
- The Markdown prompt body tells the Codex worker how to execute and hand off the issue.

Takt exposes `target` to prompts and base instructions but does not branch scheduler behavior on
stack labels such as `typescript-web`, `go-service`, or `ios-host`.

## Worker Handoff API

Workers do not create GitHub PRs and do not receive GitHub credentials. They hand off through git
commits plus workspace-root JSON manifests:

- `github.pr_ready_file` is required for PR publication. It must be an untracked JSON object with a
  non-empty `summary` or `body`, a non-empty `verification` string list, and a non-empty `risk`
  field. `title` is optional.
- `github.evidence_file` is optional. When present, it provides reviewer evidence such as
  verification checks, supporting command metadata, app URLs, artifacts, and notes.

Both handoff files are control files, not repository artifacts. Takt rejects PR publication if either
handoff file is committed. The worker must commit intended code changes before writing the PR-ready
manifest.

## Orchestrator Responsibilities

Takt owns the delivery lifecycle around the worker:

- Dispatch eligibility and latest dispatch-decision explanations.
- Linear claim, review, and completion transitions when configured.
- Workspace containment and lifecycle hooks.
- Codex app-server startup, turn processing, approvals, user-input handling, telemetry, and
  timeouts.
- Hosted `takt_linear.linear_graphql` MCP bridge backed by orchestrator-held Linear auth.
- GitHub branch push, PR creation/update, evidence comments, PR lifecycle inspection, optional
  policy-gated merge, and PR follow-up requeueing.
- Durable restart metadata for retries, issue history, recent events, token totals, and PR metadata.
- Operator observability through structured logs, dashboard pages, and `/api/v1/*` endpoints.

## Safety Posture

Docker is the first-class worker boundary. Workers receive the issue workspace and an ephemeral
minimal Codex home, not the Takt repo root, ambient operator plugin caches, or GitHub/Linear tokens.
Codex command and file-change approvals are auto-approved under the documented runtime policy, while
user-input requests fail the run instead of stalling indefinitely.

The hosted Linear MCP bridge keeps tracker credentials inside the orchestrator and uses short-lived
runtime-reachable URLs. Docker workers use a bearer-token environment variable for that bridge. Takt
rejects multi-operation GraphQL documents before executor access and redacts tracker/GitHub secrets
and MCP bearer tokens from recorded events and tool result payloads returned to workers.

## Non-Goals

Takt is not currently trying to be:

- A generic distributed job scheduler.
- A multi-tenant control plane.
- A generic issue-tracker abstraction.
- A generic SCM abstraction.
- A rich project-management UI.
- A substitute for repository-owned tests, review, branch protection, and release policy.

The product bet is narrower: make the existing Linear -> isolated Codex worker -> GitHub PR ->
evidence/review/requeue loop reliable enough to operate.

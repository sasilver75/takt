# Operations

## Running

```bash
docker build -f docker/codex-worker.Dockerfile -t takt-codex-worker:latest .
LINEAR_API_KEY=... GITHUB_TOKEN=... pnpm dev ./WORKFLOW.md --port 8787
```

The positional argument selects the workflow file. If omitted, Takt uses `./WORKFLOW.md`.

`--port` enables the optional HTTP status surface and overrides `server.port` from workflow front matter. The server binds loopback by default.

`--reconcile-once` restores durable state, runs tracker/GitHub lifecycle reconciliation, applies PR review/completion state transitions, and exits without fetching candidate issues or launching workers. Use it after downtime or manual PR merges when you want Takt to catch up Linear/GitHub state without starting new implementation work.

`examples/WORKFLOW.md` targets the real Linear project `Takt` in the `Samcorp` team. Linear's generated project slug is `5f14e4e68dc4`; the team handoff state is `Needs Human`.

## Workflow Reload

The service watches `WORKFLOW.md` and reloads config and prompt content without restart. Reloaded settings apply to future dispatch, retries, hooks, reconciliation, and agent launches. In-flight Codex sessions are not restarted just because config changed.

If reload fails, Takt logs `workflow reload failed` and keeps using the last known good config.

## Durable State

Takt persists restart-meaningful orchestration state to `workspace.root/.takt/state.json` with atomic JSON writes. The file contains retry entries, completed issue IDs, issue debug history, recent orchestrator events, token totals, and PR tracking metadata. It intentionally does not persist live process handles, raw tracker/GitHub credentials, Codex auth, or worker container state.

On startup, Takt restores the retry queue and issue history from that snapshot, then reconciles tracker and GitHub state before dispatching new work. Running Codex sessions are not resumed after a process restart; they become fresh attempts if tracker/GitHub reconciliation says the issue still needs work.

## Safety Posture

This implementation treats Docker as the first-class worker runtime. `runtime.kind: docker` runs Codex app-server inside a per-issue container with the issue workspace mounted at `/workspace`; `runtime.kind: host` remains available for local debugging and deterministic tests.

The default Docker worker image can be built with:

```bash
docker build -f docker/codex-worker.Dockerfile -t takt-codex-worker:latest .
```

The worker image includes Chromium plus `takt-capture-url`, a small headless screenshot helper. Workers should still prefer a target repository's own Playwright/Cypress/browser tests when present, but the helper gives every Docker worker a baseline way to capture reviewer-visible screenshots under `artifacts/`.

The current safety posture is:

- Codex command execution and file-change approval requests are auto-approved for the session.
- Codex user-input requests are not allowed to stall indefinitely; the client returns an empty protocol response, records `turn_input_required`, and fails the current worker run so the orchestrator retries or surfaces the blocker.
- Workspace isolation is runtime-scoped: every agent subprocess is launched in the per-issue workspace inside the selected runtime, and host workspace paths must remain under `workspace.root`.
- Leave `workspace.root` unset unless there is a concrete deployment reason; the default temp-directory root avoids package-manager parent traversal into this repo.
- `after_create` and `before_remove` hooks are host workspace lifecycle hooks. `before_run` and `after_run` execute through the selected worker runtime, so Docker workflows install dependencies and write run evidence inside the same container filesystem view used by Codex. The example workflow clones once on `after_create`, then runs `git fetch origin main && git rebase origin/main` on every `before_run`; reused workspaces therefore replay worker commits onto the current source branch, while conflicts fail visibly instead of being destructively reset.
- Linear credentials are resolved from workflow config/env indirection, redacted from logs, and scrubbed from the Codex app-server child environment.
- GitHub credentials are resolved from workflow config/env indirection and used only by the orchestrator-owned PR publisher. Workers do not receive `GITHUB_TOKEN`; they commit changes and write the configured PR-ready manifest.
- Agent-side Linear actions should use the Takt-owned `linear_graphql` tool exposed by the `takt_linear` MCP server. Takt hosts that MCP server on a short-lived Streamable HTTP endpoint and registers only its runtime URL with Codex; no Linear API key or bridge token is written into the worker workspace. Docker workers use an MCP bearer-token env var rather than an argv or workspace-file secret.
- Docker workers receive a runtime lease env including `TAKT_RUN_ID`, `TAKT_PORT_BASE`, `PORT`, `APP_PORT`, `VITE_PORT`, `DATABASE_PORT`, `REDIS_PORT`, `TMPDIR`, and `COMPOSE_PROJECT_NAME` to reduce port/service-name collisions.
- The Docker workflow uses Docker as the primary execution boundary and sets Codex's inner thread/turn sandbox to danger-full-access to avoid nested bubblewrap namespace failures inside containers. Keep the Docker mount set minimal: issue workspace plus ephemeral Codex auth only.
- The Docker image/build context excludes `keys.txt`, `.env*`, `node_modules`, `dist`, and `.git`.
- `.takt` is orchestrator-owned runtime wiring. Workers are instructed not to inspect it, print it, or commit it.

When `github.enabled: true`, the issue-to-PR loop is:

1. Takt moves the issue to `tracker.claim_state` before launching the worker.
2. The worker implements, verifies, commits, and writes `github.pr_ready_file` in the workspace root. The PR-ready and evidence manifest files are handoff control files, not repository artifacts; they must remain uncommitted. Takt rejects PR publishing if either handoff manifest is tracked by git.
3. If useful, the worker writes `github.evidence_file` with reviewer evidence such as app URLs, successful verification checks, supporting command metadata, screenshots, traces, logs, or reports. Use the manifest `verification` list for checks that completed successfully and directly support the PR claim; use the optional `commands` list for supporting operations such as dev-server launch, screenshot capture, log export, or trace collection. Takt renders repository-relative artifact paths as PR-branch links and renders screenshot/image artifacts as inline PR-comment previews when a raw GitHub URL can be derived. Small local files or directories listed under `artifacts/` may be left uncommitted; Takt allows those paths through the clean-workspace gate and uploads the discovered files to the PR branch before posting evidence. Other durable artifact files should be committed with the worker changes. Takt adds artifact warnings when a listed path is missing, invalid, outside the workspace, too large to upload, truncated by the per-directory upload cap, or not available on the PR branch. A malformed evidence manifest blocks PR publication and leaves an operator-visible retry/error instead of being silently ignored.
4. Takt pushes a branch named from `github.branch_prefix` and the issue identifier/title.
5. Takt creates or updates a GitHub PR against `github.base_branch`.
6. Takt publishes evidence as a sticky PR conversation comment, comments each PR URL in Linear at most once, and moves the issue to `tracker.review_state`.

After a PR is published, Takt owns the PR lifecycle reconciliation loop:

- On every poll, Takt discovers open PRs whose head branch starts with `github.branch_prefix`, infers the Linear issue identifier from the PR title/body/branch, and reconnects them to tracker issues. On first successful PR recovery after process start, it also scans recently updated closed PR pages with the same branch-prefix filter, which lets a restarted orchestrator observe human-merged managed PRs even if the merge happened while Takt was offline. The closed scan is bounded to the five most recent GitHub pages to avoid turning every poll into a full repository-history crawl.
- It inspects the GitHub PR, latest head checks, top-level PR conversation comments, reviews, inline review comments, and unresolved review threads on each poll tick.
- Pending checks, passing checks, and review-required states stay in the human-review lane.
- Merged or closed PRs are recorded as terminal PR states in the issue debug record. If `github.merge.complete_state` is configured, observed merged PRs move the Linear issue to that state whether the PR was merged by Takt or by a human.
- Failing checks, top-level PR comments, current-head requested changes, current-head unresolved review threads, or current-head inline comments move the Linear issue back to `tracker.claim_state`, comment a concise follow-up brief in Linear, and launch or queue another worker attempt. Review summaries, inline comments, and review threads tied to an older head SHA or marked outdated are ignored during cold PR recovery so Takt does not repeatedly requeue feedback a previous worker already addressed. The worker receives that same brief in its first-turn prompt, including failing check names, PR conversation comments, review summaries, unresolved thread excerpts, and inline comment excerpts.
- Workers still do not receive `GITHUB_TOKEN`; they update the existing branch by committing in the issue workspace and refreshing `github.pr_ready_file`. Takt republishes the PR from the orchestrator side.
- If `github.merge.enabled: true`, Takt can merge PRs after reconciliation reports an open non-draft PR satisfying the configured policy. The default policy requires `checks_status=success`, `review_status=approved`, and `mergeable_state=clean`; the merge call is pinned to the inspected head SHA. When `github.merge.complete_state` is set, Takt moves the Linear issue to that state after a successful Takt merge or after observing a human-merged managed PR.

The merge extension is opt-in. Keep it disabled for workflows where a human should press the merge button, or enable it only after branch protection and required checks express the repository's real release policy.

The configured `runtime.docker.codex_home` path is used only as an auth source. Takt copies `auth.json` into an ephemeral per-run temp directory, mounts that minimal copy read-write into the worker container, and deletes it during runtime cleanup. It intentionally does not copy Codex plugin caches, marketplace config, app approvals, rollout state, or shell history, so workers do not inherit ambient Linear/GitHub/Vercel tools from the operator environment. Use a dedicated low-privilege Codex account/home for production factory runs. For a more restrictive deployment, also set stricter Codex `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` values in `WORKFLOW.md`, and run Takt itself under a dedicated OS/container/VM boundary with limited credentials.

## Observability

Structured logs are written as stable `key=value` lines. Issue logs include `issue_id` and `issue_identifier`; session lifecycle logs include `session_id` when available.

When the HTTP extension is enabled:

- `GET /` returns a human-readable dashboard.
- `GET /issues/<issue_identifier>` returns a human-readable issue drill-down with workspace, attempts, PR lifecycle, evidence, errors, and recent issue events.
- `GET /api/v1/state` returns running sessions, retry queue, published PR status, token/runtime totals, and rate limits.
- `GET /api/v1/<issue_identifier>` returns issue-specific debug state, including the bounded per-issue worker run-attempt ledger.
- `GET /api/v1/<issue_identifier>/artifacts` lists local evidence artifacts declared by the issue's evidence manifest and includes local artifact scan warnings such as directory truncation.
- `GET /artifacts/<issue_identifier>/<artifact_path>` serves local evidence files for paths declared by the evidence manifest under `artifacts/`. Paths outside that durable artifact root are rejected; served files include restrictive content security headers.
- `POST /api/v1/refresh` queues an immediate poll/reconcile tick.
- `linear_graphql_mcp_configured`, `linear_graphql_bridge_started`, and `linear_graphql_tool_call` events show whether the Takt-owned Linear tool was configured, had a live runtime-reachable MCP bridge, and was used by a worker. Tracker secret values and MCP bearer tokens are redacted before event payloads are recorded.
- PR rows include evidence comment links, manifest summaries, and artifact warning counts when a worker writes `github.evidence_file`, so operators can see artifact/app/check/command/warning counts from the dashboard and `/api/v1/state`. Issue drill-down pages show command metadata separately from completed verification checks. Evidence file auto-publishing is intentionally bounded to workspace-contained paths under `artifacts/`, with a 10 MiB per-file limit.

Workflow front matter can tune retained observability history with `observability.recent_event_limit`, `observability.issue_event_limit`, and `observability.run_attempt_limit`. Defaults are `200`, `50`, and `50`.

## Real Integration

The deterministic Vitest suite uses fake Linear/local tracker and fake Codex app-server harnesses. `pnpm test:factory` is the highest-signal local check: it copies `examples/toy-webapp` into an isolated workspace, lets a scripted app-server modify backend and frontend TypeScript, handles tool/approval requests, compiles the resulting app, and validates handoff status.

Live Linear/Codex checks are explicit operator actions because they require credentials, network access, and permission to touch real external systems. The non-mutating preflight profile is skip-visible by default:

```bash
pnpm integration:live
TAKT_LIVE_INTEGRATION=1 LINEAR_API_KEY=... GITHUB_TOKEN=... pnpm integration:live -- ./examples/WORKFLOW.md
```

Without `TAKT_LIVE_INTEGRATION=1`, the command prints `SKIP` and exits successfully. When enabled, it loads the workflow, validates dispatch config, reads the configured Linear candidate queue, and reads GitHub repository metadata when `github.enabled` is true. It does not transition issues, comment on tickets, push branches, open PRs, or run Codex workers. Mutating full-loop checks remain controlled operator runs.

Live runs performed during May 15-16, 2026:

- Linear project: `Takt` (`5f14e4e68dc4`).
- `SAM-65`, `Validate Takt live run on Takt`: real Codex app-server ran through Takt, created and locally committed `LIVE_RUN_RESULT.md` in the per-issue workspace, added a Linear handoff comment, and moved the issue to `Needs Human`. This first run exposed two operator issues: the GitHub remote still contained the placeholder source, and an in-repo workspace root allowed package-manager parent traversal.
- Corrections applied: pushed the TypeScript Takt implementation to `origin/main` and returned the workflow to the default temp-directory workspace root.
- `SAM-66`, `Validate Takt live run after GitHub source sync`: real Takt cloned `origin/main` into an isolated temp workspace, Codex verified the checked-out repository contained the TypeScript implementation, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_REMOTE_RUN_RESULT.md` in the per-issue workspace, added a Linear handoff comment, and moved the issue to `Needs Human`.
- `SAM-67`, `Validate Takt-owned Linear GraphQL tool path`: real Codex discovered the generated `takt_linear` MCP server and attempted `linear_graphql`; the run exposed that app-server MCP elicitation responses require an `{ action, content }` shape.
- `SAM-68`, `Validate Takt-owned Linear GraphQL tool path after elicitation fix`: real Codex reached the MCP tool after elicitation handling, then exposed that MCP subprocesses are not guaranteed to inherit the app-server process environment. Takt now uses a loopback bridge so the MCP subprocess never needs the Linear API key.
- `SAM-69`, `Validate Takt Linear MCP loopback bridge`: real Codex cloned `origin/main` at `b386877867bc0a49a7cff830a0eb758c07e1a1d8`, discovered the generated `takt_linear` MCP server, accepted MCP elicitation with the required shape, used `linear_graphql` through the loopback bridge for Linear reads/comment/state transition, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_LINEAR_GRAPHQL_BRIDGE_RESULT.md` locally in the per-issue workspace, added the handoff comment, and moved the issue to `Needs Human`.
- `SAM-70`, `Validate hosted Takt Linear MCP hardening`: real Codex cloned `origin/main` at `cdff48f5905c622c423b1f36673a56179c588b29`, discovered the hosted Streamable HTTP `takt_linear` MCP server, used `linear_graphql` for Linear reads/comment/state transition, verified there was no workspace `.takt/linear-graphql-mcp.mjs` or `linear-graphql-mcp.mjs` file outside `node_modules`, confirmed app-server argv/config used `mcp_servers.takt_linear.url` without a Linear API key or bridge token marker, ran `pnpm typecheck` and `pnpm test`, committed `LIVE_HOSTED_MCP_RESULT.md` locally in the per-issue workspace, added the handoff comment, and moved the issue to `Needs Human`.
- `SAM-71`, `Validate Docker-first Takt worker runtime`: real Codex ran through `codex app-server` inside the Docker worker container with the issue workspace mounted at `/workspace`, discovered and used the authenticated hosted `takt_linear.linear_graphql` MCP tool, confirmed `keys.txt` was absent from `/workspace`, confirmed app-server argv used `bearer_token_env_var` instead of raw Linear credentials, ran `pnpm typecheck` and `pnpm test`, recorded detailed runtime evidence in the per-issue workspace, added the handoff comment, and moved the issue to `Needs Human`. This run exposed that a reused git workspace can remain on an older commit if the workflow only clones on `after_create`; the example workflow now fast-forwards reused workspaces during `before_run`.
- `SAM-75`, `Validate Takt evidence artifact links in a live PR`: real Docker/Codex worker ran from an isolated live-validation workspace root, used `takt_linear.linear_graphql`, added a small committed evidence artifact on the worker branch, ran `pnpm verify`, wrote `TAKT_PR_READY.json` and `TAKT_EVIDENCE.json`, and let Takt publish PR #4 plus sticky evidence comment `https://github.com/sasilver75/takt/pull/4#issuecomment-4467788558`. The evidence artifact rendered as a GitHub blob link to the worker branch and PR CI passed. The operator run also exposed two hardening gaps that are now covered by tests: restored PR tracking is ignored when a workflow changes `github.branch_prefix`, and dispatch validation rejects `tracker.claim_state` values that are not listed in `tracker.active_states`.
- `SAM-76`, `Validate Takt auto-publishes uncommitted evidence artifacts`: real Docker/Codex worker ran from an isolated live-validation workspace root, used `takt_linear.linear_graphql`, committed a source documentation note, ran `pnpm verify`, left a small artifact uncommitted in the worker workspace, wrote `TAKT_PR_READY.json` and `TAKT_EVIDENCE.json`, and let Takt upload the uncommitted artifact to PR #5 before posting sticky evidence comment `https://github.com/sasilver75/takt/pull/5#issuecomment-4468087596`. CI passed on the PR. This run exposed that handoff manifests must never land on `main`; Takt now rejects PR publishing if `github.pr_ready_file` or `github.evidence_file` is tracked by git.
- `SAM-90`, `Validate screenshot evidence artifact with takt-capture-url`: real Docker/Codex worker ran from an isolated live-validation workspace root, used `takt_linear.linear_graphql`, ran the toy webapp, captured `artifacts/SAM-90/toy-home.png` with `takt-capture-url`, ran `pnpm verify`, wrote `TAKT_PR_READY.json` and `TAKT_EVIDENCE.json`, and let Takt publish PR #6 plus sticky evidence comment `https://github.com/sasilver75/takt/pull/6#issuecomment-4468480674`. CI passed on the PR and the uploaded PNG artifact was available from the PR branch. This run exposed that evidence manifests need to distinguish completed verification checks from supporting launch/capture commands.

Before production use:

- Verify the configured Linear project exists and has the intended active issue queue.
- Run Takt against one controlled issue/workspace before allowing broader concurrency.
- Verify hooks on the target host shell.
- Confirm the chosen approval/sandbox policy matches the risk profile.

## Verification Commands

- `pnpm typecheck`: typechecks the Takt service.
- `pnpm test`: runs unit and deterministic integration tests.
- `pnpm test:factory`: runs only the toy web-app production-factory harness.
- `pnpm toy:typecheck`: typechecks the toy frontend/backend fixture.
- `pnpm integration:live`: reports a skipped real-integration profile by default; with `TAKT_LIVE_INTEGRATION=1`, performs non-mutating live Linear/GitHub readiness checks.
- `pnpm verify`: runs the full local gate used by CI.

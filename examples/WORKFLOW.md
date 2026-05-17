---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 5f14e4e68dc4
  active_states:
    - Ready
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Duplicate
  claim_state: In Progress
  review_state: Needs Human
polling:
  interval_ms: 30000
github:
  enabled: true
  owner: sasilver75
  repo: takt
  token: $GITHUB_TOKEN
  remote: origin
  base_branch: main
  branch_prefix: takt
  pr_ready_file: TAKT_PR_READY.json
  evidence_file: TAKT_EVIDENCE.json
  draft: false
  merge:
    enabled: false
    method: squash
    require_approval: true
    require_successful_checks: true
    require_clean_merge: true
    delete_branch: true
    complete_state: Done
runtime:
  kind: docker
  docker:
    image: takt-codex-worker:latest
    workspace_mount: /workspace
    codex_home: ~/.codex
    codex_home_mount: /root/.codex
    mcp_host: host.docker.internal
    mcp_bind_host: 0.0.0.0
    add_host_gateway: true
hooks:
  timeout_ms: 60000
  after_create: |
    git clone https://github.com/sasilver75/takt.git .
  before_run: |
    git fetch origin main
    git rebase origin/main
    git config user.name "Takt Worker"
    git config user.email "takt-worker@example.invalid"
    rm -rf .pnpm-store
    pnpm install --frozen-lockfile=false --store-dir "$TMPDIR/pnpm-store"
agent:
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    Needs Human: 1
codex:
  command: codex app-server
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
  linear_graphql_mcp:
    enabled: true
    server_name: takt_linear
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
observability:
  recent_event_limit: 200
  issue_event_limit: 50
  run_attempt_limit: 50
server:
  port: 8787
---
# Takt Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}`.

Issue URL: {{ issue.url }}
Current state: {{ issue.state }}
Attempt: {{ attempt }}

Use the repository-local instructions, inspect the code before editing, implement the issue completely, run focused verification, and commit the finished changes.

Use Takt's `linear_graphql` tool from the `takt_linear` MCP server for Linear reads. Do not use other Linear tools, and do not read raw Linear credentials from disk. Do not inspect Takt harness internals. If `linear_graphql` is unavailable, leave repo-local handoff evidence and report that blocker instead of switching to an ambient Linear integration.

When the implementation is ready for PR review, write `TAKT_PR_READY.json` in the workspace root:

```json
{
  "title": "SAM-123: concise PR title",
  "summary": "What changed and why.",
  "verification": ["pnpm test", "pnpm build"],
  "risk": "Known risks or Notable none."
}
```

If you ran the application, used Playwright, captured screenshots/traces/logs, or produced other reviewer evidence, write `TAKT_EVIDENCE.json` in the workspace root:

```json
{
  "summary": "What was verified from the running app.",
  "verification": ["pnpm test", "pnpm build", "npx playwright test"],
  "commands": [
    {
      "kind": "server",
      "status": "started",
      "command": "pnpm dev -- --host 127.0.0.1",
      "description": "Served the app for browser inspection."
    },
    {
      "kind": "capture",
      "status": "succeeded",
      "command": "takt-capture-url http://127.0.0.1:3000 artifacts/SAM-123/homepage.png"
    }
  ],
  "app_urls": ["http://127.0.0.1:3000"],
  "artifacts": [
    { "kind": "screenshot", "path": "artifacts/SAM-123/homepage.png", "description": "Homepage after the change." },
    { "kind": "trace", "path": "artifacts/SAM-123/playwright-trace.zip" }
  ],
  "notes": "Reviewer caveats or Notable none."
}
```

Use `verification` only for checks that completed successfully and directly support the PR claim. Use `commands` for supporting evidence commands such as starting a dev server, collecting logs, capturing screenshots, or exporting traces.

The Docker worker image includes Chromium and a `takt-capture-url <url> <output-path> [width,height]` helper for simple browser screenshots. Prefer the target repo's Playwright/Cypress/browser tests when present; use the helper for lightweight visual evidence when the repo has no browser test harness yet.

Small local files or directories listed under `artifacts/` may be left uncommitted; Takt will publish those evidence files to the PR branch before posting the PR evidence comment. Commit artifact files outside `artifacts/` if they are intentionally durable reviewer evidence. Do not commit transient server logs unless they are intentionally useful evidence.

Do not create the GitHub PR yourself and do not move the Linear issue to review. Takt will push the branch, create or update the PR, publish evidence as a PR comment, comment the PR link in Linear, and move the issue to `Needs Human`.

If this run is a PR follow-up, Takt will append an orchestrator follow-up context section after this prompt with failing checks, PR conversation comments, review summaries, unresolved review threads, or inline review comments. Treat that section as the current task brief and update the existing branch/PR rather than starting a new issue branch.

Safety requirements:

- Do not print or commit secrets.
- Keep all commands inside this issue workspace.
- Treat Takt runtime wiring as orchestrator-owned, not implementation context.
- Prefer small commits and clear verification evidence.
- Commit all intended code changes before writing `TAKT_PR_READY.json`.

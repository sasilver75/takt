---
target:
  name: Example TypeScript Web App
  kind: typescript-web
  repository: github.com/acme/webapp
  description: Full-stack TypeScript web application.
  instructions:
    - Prefer repository scripts over ad hoc commands.
    - Capture browser evidence when UI behavior changes.
  verification:
    - pnpm typecheck
    - pnpm test
    - pnpm build
  evidence:
    - Include app URL and screenshot artifacts for visible UI changes.
  handoff: GitHub PR for human review
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: replace-with-linear-project-slug
  active_states:
    - Ready
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  claim_state: In Progress
  review_state: Needs Human
github:
  enabled: true
  owner: acme
  repo: webapp
  token: $GITHUB_TOKEN
  remote: origin
  base_branch: main
  branch_prefix: takt
runtime:
  kind: docker
  docker:
    image: takt-codex-worker:latest
    workspace_mount: /workspace
    codex_home: ~/.codex
hooks:
  timeout_ms: 120000
  after_create: |
    git clone https://github.com/acme/webapp.git .
  before_run: |
    git fetch origin main
    git rebase origin/main
    git config user.name "Takt Worker"
    git config user.email "takt-worker@example.invalid"
    pnpm install --frozen-lockfile
agent:
  max_concurrent_agents: 2
codex:
  command: codex app-server
---
# TypeScript Web Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}` for `{{ target.name }}`.

Read repository-local instructions before editing. Implement the issue completely, keep changes scoped, run focused verification, commit the result, and write `TAKT_PR_READY.json`.

Verification expectations:
{% for command in target.verification %}
- `{{ command }}`
{% endfor %}

If UI behavior changes, run the app and capture reviewer-visible evidence under `artifacts/{{ issue.identifier }}/`. The Docker worker includes Chromium and `takt-capture-url`.

---
target:
  name: Example Go Service
  kind: go-service
  repository: github.com/acme/api
  description: Go backend service with API and persistence layers.
  instructions:
    - Prefer Makefile targets when they exist.
    - Keep database migrations backward compatible.
  verification:
    - go test ./...
    - go vet ./...
  evidence:
    - Include API health output or logs when runtime behavior changes.
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
  repo: api
  token: $GITHUB_TOKEN
  remote: origin
  base_branch: main
  branch_prefix: takt
runtime:
  kind: docker
  docker:
    image: takt-codex-worker-go:latest
    workspace_mount: /workspace
    codex_home: ~/.codex
hooks:
  timeout_ms: 120000
  after_create: |
    git clone https://github.com/acme/api.git .
  before_run: |
    git fetch origin main
    git rebase origin/main
    git config user.name "Takt Worker"
    git config user.email "takt-worker@example.invalid"
    go mod download
agent:
  max_concurrent_agents: 2
codex:
  command: codex app-server
---
# Go Service Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}` for `{{ target.name }}`.

Inspect the Go service structure and repo-local instructions before editing. Prefer existing Makefile targets and package boundaries. Run the target verification commands, commit the result, and write `TAKT_PR_READY.json`.

Verification expectations:
{% for command in target.verification %}
- `{{ command }}`
{% endfor %}

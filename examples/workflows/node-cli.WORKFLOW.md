---
target:
  name: Example Node CLI
  kind: node-cli
  repository: github.com/acme/task-summary
  description: No-server Node.js CLI or library package with deterministic tests.
  instructions:
    - Prefer built-in Node tooling when the package has no dependencies.
    - Keep command output stable so tests can assert exact text.
  verification:
    - node --test
  evidence:
    - Include command output when CLI behavior changes.
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
  repo: task-summary
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
    git clone https://github.com/acme/task-summary.git .
  before_run: |
    git fetch origin main
    git rebase origin/main
    git config user.name "Takt Worker"
    git config user.email "takt-worker@example.invalid"
    npm ci --ignore-scripts
agent:
  max_concurrent_agents: 2
codex:
  command: codex app-server
---
# Node CLI Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}` for `{{ target.name }}`.

Inspect the package scripts and command boundaries before editing. Keep CLI output deterministic, run the target verification commands, commit the result, and write `TAKT_PR_READY.json`.

Verification expectations:
{% for command in target.verification %}
- `{{ command }}`
{% endfor %}

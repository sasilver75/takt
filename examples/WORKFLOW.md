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
polling:
  interval_ms: 30000
hooks:
  timeout_ms: 60000
  after_create: |
    git clone https://github.com/sasilver75/galatin-demo.git .
  before_run: |
    pnpm install --frozen-lockfile=false
agent:
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    Needs Human: 1
codex:
  command: codex app-server
  linear_graphql_mcp:
    enabled: true
    server_name: symphony_linear
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 8787
---
# Symphony Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}`.

Issue URL: {{ issue.url }}
Current state: {{ issue.state }}
Attempt: {{ attempt }}

Use the repository-local instructions, inspect the code before editing, implement the issue completely, run focused verification, and leave a concise handoff in Linear using the available tools. When work is ready for review, move the issue to `Needs Human`.

Use Symphony's `linear_graphql` tool from the `symphony_linear` MCP server for all Linear reads, comments, and state changes. Do not use other Linear tools unless `linear_graphql` is unavailable, and do not read raw Linear credentials from disk.

Safety requirements:

- Do not print or commit secrets.
- Keep all commands inside this issue workspace.
- Prefer small commits and clear verification evidence.
- If the issue should move to human review, make the handoff explicit.

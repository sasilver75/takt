---
target:
  name: Example iOS App
  kind: ios-host
  repository: github.com/acme/ios-app
  description: iOS application that requires a macOS host with Xcode installed.
  instructions:
    - Use host runtime because Xcode and the simulator are macOS-bound.
    - Prefer repository scripts or documented Xcode schemes.
  verification:
    - xcodebuild -scheme ExampleApp -destination 'platform=iOS Simulator,name=iPhone 16' test
  evidence:
    - Include simulator screenshots when user-visible UI changes.
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
  repo: ios-app
  token: $GITHUB_TOKEN
  remote: origin
  base_branch: main
  branch_prefix: takt
runtime:
  kind: host
hooks:
  timeout_ms: 180000
  after_create: |
    git clone git@github.com:acme/ios-app.git .
  before_run: |
    git fetch origin main
    git rebase origin/main
    git config user.name "Takt Worker"
    git config user.email "takt-worker@example.invalid"
    xcodebuild -resolvePackageDependencies
agent:
  max_concurrent_agents: 1
codex:
  command: codex app-server
---
# iOS Host Worker Prompt

You are working on Linear issue `{{ issue.identifier }}: {{ issue.title }}` for `{{ target.name }}`.

Use the repository's Xcode schemes and Swift conventions. Keep changes scoped, run the target verification command when practical, commit the result, and write `TAKT_PR_READY.json`.

Verification expectations:
{% for command in target.verification %}
- `{{ command }}`
{% endfor %}

# Architecture

Takt is split into layers that mirror `SPEC.md` and keep the service legible to future agent runs.

## Layer Map

- Workflow and policy: `src/workflow/*`
  - Loads `WORKFLOW.md`, parses optional YAML front matter, watches for changes, and renders strict prompts.
- Typed configuration: `src/config/config.ts`
  - Applies defaults, resolves `$VAR` only where explicitly configured, expands workspace paths, and validates dispatch preflight.
- Tracker integration: `src/tracker/linear.ts`
  - Implements Linear candidate fetch, terminal-state fetch, state refresh, state transitions, comments, normalization, pagination, and the `linear_graphql` extension backend.
- PR publishing: `src/github/publisher.ts`
  - Pushes committed worker branches and creates or updates GitHub pull requests with orchestrator-held credentials after a worker writes the configured PR-ready manifest.
- PR lifecycle tracking: `src/github/tracker.ts`
  - Discovers open Takt PRs by branch prefix after restart, then inspects PRs, head check runs, top-level PR conversation comments, reviews, inline review comments, and unresolved review threads so the orchestrator can decide whether to wait for humans, requeue worker follow-up, or record terminal PR state.
- PR evidence publishing: `src/github/evidence.ts`
  - Reads worker evidence manifests after PR publication, publishes bounded local files under `artifacts/` to the PR branch, and creates or updates a sticky PR comment with verification commands, app URLs, and artifact pointers.
- PR merging: `src/github/merger.ts`
  - Optionally merges approved, passing, clean PRs using orchestrator-held GitHub credentials and the inspected head SHA, then deletes the worker branch and moves the tracker issue to the configured completion state.
- Workspace execution boundary: `src/workspace/manager.ts`
  - Maps issue identifiers to sanitized workspace keys, enforces root containment, and runs lifecycle hooks with timeouts.
- Worker runtime boundary: `src/runtime/workerRuntime.ts`
  - Creates a per-run runtime lease. Docker is the first-class runtime: Codex app-server runs in a per-issue container with the workspace mounted at `/workspace`, unique runtime env/ports, Chromium-based screenshot capability, and deterministic cleanup. Host runtime remains for local tests and debugging.
- Agent execution: `src/agent/*`
  - Launches `codex.command` through the selected worker runtime, hosts a short-lived Streamable HTTP MCP server for `takt_linear`, registers its runtime-reachable URL with Codex for `linear_graphql`, speaks app-server JSON-RPC over stdio, handles approvals/user input/tool calls by policy, and streams events upward.
- Coordination: `src/orchestrator/orchestrator.ts`
  - Owns mutable scheduler state, polling, dispatch, reconciliation, retry timers, token accounting, and runtime snapshots.
- Durable state: `src/persistence/jsonStateStore.ts`
  - Persists restart-meaningful scheduler metadata under `workspace.root/.takt/state.json` and restores retry/history state before the first startup poll.
- Observability and control: `src/observability/*`, `src/http/*`
  - Emits structured key/value logs and optionally exposes dashboard/API endpoints.
- Deterministic factory harness: `src/harness/toyWebappFactory.test.ts`, `examples/toy-webapp`
  - Builds a frontend/backend TypeScript app in an isolated workspace, drives a scripted app-server session, exercises approval/tool handling, and verifies the produced artifact.

## Invariants

- The orchestrator is the only owner of claim/running/retry state.
- Agent subprocesses launch only with runtime `cwd` equal to the per-issue workspace path inside that runtime, `/workspace` for Docker and the host workspace path for host fallback.
- Workspace paths must remain below the configured workspace root.
- The Takt Linear MCP server is hosted by the orchestrator. Host workers receive a loopback URL; Docker workers receive a `host.docker.internal` URL plus a per-run bearer-token env-var reference. Linear auth stays inside the orchestrator-owned tracker adapter.
- Tracker secrets are removed from the Codex app-server environment and redacted from Takt logs and status events. Workers are instructed to treat `.takt` as orchestrator-owned wiring rather than task context.
- GitHub publishing, discovery, inspection, evidence comments, and optional merging credentials stay in the orchestrator. Workers produce commits plus PR-ready/evidence manifests; Takt owns branch push, PR creation/update, PR status/review/comment/thread inspection, PR evidence publication, Linear PR comments, review/completion-state transitions, restart recovery for open and recently closed managed Takt PRs, follow-up requeue decisions, human-merge observation, and configured PR merges.
- Durable state stores scheduler metadata only: retry queue, completed issue IDs, issue history, recent events, token totals, and PR metadata. It must not contain raw Linear/GitHub secrets or Codex auth material.
- Docker workers mount only the per-issue workspace and an ephemeral per-run Codex home containing auth material copied from the configured source. Operator plugin caches, app approvals, rollout state, shell history, `keys.txt`, and the repo root are not mounted or copied into the image/build context.
- Issue identifiers are sanitized before they become directory names.
- Secrets are accepted through config/env resolution but never logged.
- `WORKFLOW.md` changes are reloaded without restart; invalid reloads keep the last known good config.

## Agent-First Harness Principles

The implementation incorporates OpenAI's [harness engineering guidance](https://openai.com/index/harness-engineering/) and the [Symphony orchestration spec announcement](https://openai.com/index/open-source-codex-orchestration-symphony/):

- Keep repository-local docs and schemas as the system of record.
- Make runtime state legible through logs and the HTTP snapshot API.
- Prefer typed boundaries and deterministic fakes over guessed external payloads.
- Encode safety/quality rules in tests and config validation instead of relying on operator memory.
- Test the harness against a real app-shaped artifact, not only unit-level fakes.

The Symphony announcement frames this repo as a production-factory harness: Linear is the work queue, workspaces are isolated factories, Codex agents execute, and observability closes the feedback loop.

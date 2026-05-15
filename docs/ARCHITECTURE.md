# Architecture

Symphony is split into layers that mirror `SPEC.md` and keep the service legible to future agent runs.

## Layer Map

- Workflow and policy: `src/workflow/*`
  - Loads `WORKFLOW.md`, parses optional YAML front matter, watches for changes, and renders strict prompts.
- Typed configuration: `src/config/config.ts`
  - Applies defaults, resolves `$VAR` only where explicitly configured, expands workspace paths, and validates dispatch preflight.
- Tracker integration: `src/tracker/linear.ts`
  - Implements Linear candidate fetch, terminal-state fetch, state refresh, normalization, pagination, and the `linear_graphql` extension backend.
- Workspace execution boundary: `src/workspace/manager.ts`
  - Maps issue identifiers to sanitized workspace keys, enforces root containment, and runs lifecycle hooks with timeouts.
- Agent execution: `src/agent/*`
  - Launches `bash -lc <codex.command>` in the per-issue workspace, speaks app-server JSON-RPC over stdio, handles approvals/user input/tool calls by policy, and streams events upward.
- Coordination: `src/orchestrator/orchestrator.ts`
  - Owns mutable scheduler state, polling, dispatch, reconciliation, retry timers, token accounting, and runtime snapshots.
- Observability and control: `src/observability/*`, `src/http/*`
  - Emits structured key/value logs and optionally exposes dashboard/API endpoints.
- Deterministic factory harness: `src/harness/toyWebappFactory.test.ts`, `examples/toy-webapp`
  - Builds a frontend/backend TypeScript app in an isolated workspace, drives a scripted app-server session, exercises approval/tool handling, and verifies the produced artifact.

## Invariants

- The orchestrator is the only owner of claim/running/retry state.
- Agent subprocesses launch only with `cwd` equal to the per-issue workspace path.
- Workspace paths must remain below the configured workspace root.
- Issue identifiers are sanitized before they become directory names.
- Secrets are accepted through config/env resolution but never logged.
- `WORKFLOW.md` changes are reloaded without restart; invalid reloads keep the last known good config.

## Agent-First Harness Principles

The implementation incorporates the OpenAI harness engineering guidance:

- Keep repository-local docs and schemas as the system of record.
- Make runtime state legible through logs and the HTTP snapshot API.
- Prefer typed boundaries and deterministic fakes over guessed external payloads.
- Encode safety/quality rules in tests and config validation instead of relying on operator memory.
- Test the harness against a real app-shaped artifact, not only unit-level fakes.

The OpenAI Symphony announcement frames this repo as a production-factory harness: Linear is the work queue, workspaces are isolated factories, Codex agents execute, and observability closes the feedback loop.

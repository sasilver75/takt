# Workflow Contract

`WORKFLOW.md` is the per-application contract for a Takt instance. The Takt core stays opinionated about the delivery loop: Linear issue in, isolated Codex worker, GitHub PR out, evidence attached, and review feedback requeued. The target application expresses its own repo, stack, setup, verification, evidence, and handoff expectations in workflow front matter, hooks, and the prompt body.

One Takt process is expected to target one application or repository at a time. Reuse across applications comes from swapping the workflow file, worker image, hooks, and repo-local instructions, not from teaching the orchestrator about every stack.

## Target Metadata

The optional `target` section is typed metadata for humans and prompts. It does not change scheduler behavior and Takt does not branch on `target.kind`.

```yaml
target:
  name: Acme API
  kind: go-service
  repository: github.com/acme/api
  description: Public API service.
  instructions:
    - Prefer Makefile commands.
    - Keep migrations backward compatible.
  verification:
    - go test ./...
    - go vet ./...
  evidence:
    - Include API health output when behavior changes.
  handoff: GitHub PR for human review
```

The workflow prompt can render this data with Liquid variables such as `{{ target.name }}`, `{{ target.kind }}`, and loops over `target.verification`.

## Required Decisions

A target workflow should answer these questions explicitly:

- Source: which repository is cloned or synchronized into each issue workspace.
- Runtime: whether the worker uses Docker or host execution, and which worker image or host toolchain is expected.
- Setup: which hooks install dependencies, sync the branch, configure Git identity, or prepare generated artifacts.
- Worker instructions: which repo-local docs, commands, architectural boundaries, and safety rules the Codex worker should follow.
- Verification: which commands count as completed checks for `TAKT_PR_READY.json` or `TAKT_EVIDENCE.json`.
- Evidence: when to capture screenshots, traces, logs, app URLs, or other reviewer artifacts.
- Handoff: what state should be reached after PR publication, usually `tracker.review_state`.

## Contract Boundaries

Takt interprets the following fields directly:

- `tracker`: Linear project, active states, terminal states, claim/review states.
- `github`: PR publishing, evidence manifests, branch naming, review feedback, optional merge policy.
- `runtime`: Docker or host execution boundary and worker environment.
- `hooks`: workspace creation, per-run setup, post-run cleanup, and terminal cleanup.
- `agent`, `codex`, `observability`, `server`: worker limits, app-server policy, retained state, and status surface.

Takt exposes the `target` section to prompts and base instructions, but the orchestrator intentionally treats it as descriptive metadata. Stack-specific behavior belongs in hooks, worker images, and repository-local docs.

## Example Profiles

- TypeScript web app: Docker worker with Node, pnpm install in `before_run`, Playwright or app-specific tests in the prompt, Chromium evidence when UI changes.
- Go service: Docker worker with Go tooling, `go mod download` in `before_run`, `go test ./...` as primary verification.
- Node CLI/library: Docker worker with Node tooling, package install only when needed, `node --test` or the repo script as primary verification.
- iOS/macOS project: host runtime on macOS with Xcode installed, Xcode package resolution in `before_run`, `xcodebuild test` as verification.

The examples under `examples/workflows/` are templates. They are not meant to run without replacing repository, Linear project, and GitHub owner/repo values.

The runnable directories under `examples/` have a different purpose: they are durable regression fixtures for app-shaped orchestration behavior. Harness tests copy those fixtures into isolated workspaces, run the scripted Codex app-server path, make a stack-appropriate change, execute the fixture verification command, and assert Takt status, handoff, hook, and logging behavior. The current matrix is intentionally small:

| Fixture | Template | Verification |
| --- | --- | --- |
| `examples/toy-webapp` | `examples/workflows/typescript-web.WORKFLOW.md` | `tsc -p tsconfig.json` |
| `examples/toy-go-service` | `examples/workflows/go-service.WORKFLOW.md` | `go test ./...` |
| `examples/toy-node-cli` | `examples/workflows/node-cli.WORKFLOW.md` | `node --test` |

Scenario overlays should grow before the fixture zoo does. Use the existing runnable fixtures to cover continuation/retry, evidence manifests, malformed manifests, hook failure, and validator failures over time.

## Onboarding Flow

1. Choose the closest template from `examples/workflows/`.
2. Copy it to the target repository as `WORKFLOW.md` or keep it beside the Takt deployment and pass its path to `takt`.
3. Replace `target`, `tracker.project_slug`, `github.owner`, `github.repo`, clone URLs, worker image names, and verification commands.
4. Build the needed worker image:

   ```bash
   docker build -f docker/codex-worker.Dockerfile -t takt-codex-worker:latest .
   docker build -f docker/codex-worker-go.Dockerfile -t takt-codex-worker-go:latest .
   ```

5. Run the non-mutating validator:

   ```bash
   LINEAR_API_KEY=... GITHUB_TOKEN=... takt validate ./WORKFLOW.md
   ```

6. Fix every `[ERROR]` item. Review `[WARNING]` items before letting Takt dispatch real work.

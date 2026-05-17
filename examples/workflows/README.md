# Workflow Templates

These files are copy/customize templates for one-application Takt instances. They intentionally keep Linear, GitHub, Codex app-server, Docker or host runtime, and Chromium as fixed harness assumptions.

Workflow templates are not runnable fixtures by themselves. They are parsed and validated as contract examples; runnable regression fixtures live as application directories under `examples/`.

## Templates

- `typescript-web.WORKFLOW.md`: Docker-based TypeScript web app profile using the default `takt-codex-worker:latest` image.
- `go-service.WORKFLOW.md`: Docker-based Go service profile using `takt-codex-worker-go:latest`.
- `node-cli.WORKFLOW.md`: Docker-based no-server Node CLI/library profile using the default `takt-codex-worker:latest` image.
- `ios-host.WORKFLOW.md`: host-runtime profile for macOS/Xcode projects.

## Runnable Fixture Matrix

| Fixture | Matching template | Verification | Harness coverage |
| --- | --- | --- | --- |
| `examples/toy-webapp` | `typescript-web.WORKFLOW.md` | `tsc -p tsconfig.json` | Full-stack TypeScript app patch, Linear MCP handoff, hook/log/status behavior |
| `examples/toy-go-service` | `go-service.WORKFLOW.md` | `go test ./...` | Go HTTP handler patch, Linear MCP handoff, hook/log/status behavior |
| `examples/toy-node-cli` | `node-cli.WORKFLOW.md` | `node --test` | No-server CLI/library patch, Linear MCP handoff, hook/log/status behavior |

## Customize

1. Copy the closest template to `WORKFLOW.md`.
2. Replace `target.name`, `target.kind`, `target.repository`, and `target.verification`.
3. Replace `tracker.project_slug`, `github.owner`, `github.repo`, and clone URLs.
4. Confirm `hooks.after_create` populates a new issue workspace.
5. Confirm `hooks.before_run` syncs reused workspaces and installs dependencies.
6. Run `LINEAR_API_KEY=... GITHUB_TOKEN=... takt validate ./WORKFLOW.md`.

The validator is non-mutating; it does not fetch Linear candidates, push Git branches, create PRs, or launch workers.

## Add The Next Scenario

1. Add one small runnable fixture under `examples/` only when it exercises a new app shape or failure mode.
2. Add or update the closest `examples/workflows/*.WORKFLOW.md` template so its `target.kind`, setup hooks, and `target.verification` match the fixture's stack.
3. Add a deterministic harness test that copies the fixture into an isolated workspace, runs the scripted Codex app-server path, applies a stack-appropriate change, runs the fixture verification command, and asserts handoff/status/logging behavior.
4. Prefer overlays on this small matrix for continuation/retry, evidence manifests, malformed manifests, hook failure, and validator failures before adding more app fixtures.

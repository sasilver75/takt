# Workflow Templates

These files are copy/customize templates for one-application Takt instances. They intentionally keep Linear, GitHub, Codex app-server, Docker or host runtime, and Chromium as fixed harness assumptions.

## Templates

- `typescript-web.WORKFLOW.md`: Docker-based TypeScript web app profile using the default `takt-codex-worker:latest` image.
- `go-service.WORKFLOW.md`: Docker-based Go service profile using `takt-codex-worker-go:latest`.
- `ios-host.WORKFLOW.md`: host-runtime profile for macOS/Xcode projects.

## Customize

1. Copy the closest template to `WORKFLOW.md`.
2. Replace `target.name`, `target.kind`, `target.repository`, and `target.verification`.
3. Replace `tracker.project_slug`, `github.owner`, `github.repo`, and clone URLs.
4. Confirm `hooks.after_create` populates a new issue workspace.
5. Confirm `hooks.before_run` syncs reused workspaces and installs dependencies.
6. Run `LINEAR_API_KEY=... GITHUB_TOKEN=... takt validate ./WORKFLOW.md`.

The validator is non-mutating; it does not fetch Linear candidates, push Git branches, create PRs, or launch workers.

# Examples

Examples have two different jobs.

Workflow templates in `examples/workflows/` are copy/customize contracts. Tests parse and validate them so target metadata, hooks, runtime assumptions, and prompt variables stay coherent.

Runnable toy apps are regression fixtures. Harness tests copy them into isolated workspaces, drive the fake Codex app-server path, apply a stack-appropriate change, run the fixture's verification command, and assert Takt handoff/status/logging behavior.

## Current Matrix

| Runnable fixture | App shape | Verification |
| --- | --- | --- |
| `toy-webapp` | TypeScript frontend/backend web app | `tsc -p tsconfig.json` |
| `toy-go-service` | Go HTTP service | `go test ./...` |
| `toy-node-cli` | No-server Node CLI/library package | `node --test` |

Keep this matrix small. Add the next scenario when it covers a new orchestration behavior, or prefer an overlay test for continuation/retry, evidence manifests, malformed manifests, hook failure, and validator failures.

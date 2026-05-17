import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyServiceOptions } from "./service.js";
import { parseCliArgs, runCli, startCli, type CliService } from "./cli.js";

describe("CLI", () => {
  test("parses positional workflow path and port override", () => {
    expect(parseCliArgs(["./examples/WORKFLOW.md", "--port", "8787"])).toEqual({
      command: "serve",
      workflowPath: "./examples/WORKFLOW.md",
      port: 8787,
      reconcileOnce: false
    });
    expect(parseCliArgs(["--port=0"])).toEqual({ command: "serve", workflowPath: null, port: 0, reconcileOnce: false });
    expect(parseCliArgs(["--reconcile-once"])).toEqual({ command: "serve", workflowPath: null, port: null, reconcileOnce: true });
    expect(parseCliArgs(["validate", "./WORKFLOW.md"])).toEqual({ command: "validate", workflowPath: "./WORKFLOW.md", port: null, reconcileOnce: false });
    expect(parseCliArgs(["doctor"])).toEqual({ command: "validate", workflowPath: null, port: null, reconcileOnce: false });
    expect(() => parseCliArgs(["--port", "nope"])).toThrow("--port requires a non-negative integer");
    expect(() => parseCliArgs(["validate", "--port", "0"])).toThrow("validate does not support --port");
    expect(() => parseCliArgs(["--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => parseCliArgs(["one.md", "two.md"])).toThrow("Unexpected positional argument: two.md");
  });

  test("uses ./WORKFLOW.md from cwd when no workflow path is provided", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-cli-"));
    await writeFile(path.join(dir, "WORKFLOW.md"), "---\ntracker:\n  project_slug: demo\n---\nbody\n");
    const startedOptions: SymphonyServiceOptions[] = [];

    await startCli({
      argv: ["--port", "0"],
      cwd: dir,
      installSignalHandlers: false,
      serviceFactory: (options) => {
        startedOptions.push(options);
        return fakeService();
      }
    });

    expect(startedOptions[0]).toMatchObject({
      workflowPath: path.join(dir, "WORKFLOW.md"),
      port: 0,
      runMode: "daemon"
    });
  });

  test("reconcile-once starts service in reconcile mode and stops immediately", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-cli-reconcile-"));
    await writeFile(path.join(dir, "WORKFLOW.md"), "---\ntracker:\n  project_slug: demo\n---\nbody\n");
    const startedOptions: SymphonyServiceOptions[] = [];
    let stopped = false;

    await startCli({
      argv: ["--reconcile-once"],
      cwd: dir,
      installSignalHandlers: false,
      serviceFactory: (options) => {
        startedOptions.push(options);
        return {
          async start() {
            return {};
          },
          async stop() {
            stopped = true;
          }
        };
      }
    });

    expect(startedOptions[0]).toMatchObject({
      workflowPath: path.join(dir, "WORKFLOW.md"),
      runMode: "reconcile_once"
    });
    expect(stopped).toBe(true);
  });

  test("returns nonzero and writes startup errors for missing workflow files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-cli-missing-"));
    const stderr: string[] = [];
    const code = await runCli({
      argv: ["missing.md"],
      cwd: dir,
      installSignalHandlers: false,
      serviceFactory: () => {
        throw new Error("service should not start without a workflow");
      },
      stderr: writeSink(stderr)
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("takt startup failed:");
    expect(stderr.join("")).toContain("missing.md");
  });

  test("surfaces service startup failure cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-cli-failure-"));
    await writeFile(path.join(dir, "WORKFLOW.md"), "body\n");
    const stderr: string[] = [];
    const code = await runCli({
      argv: [],
      cwd: dir,
      installSignalHandlers: false,
      serviceFactory: () => ({
        async start() {
          throw new Error("config exploded");
        },
        async stop() {
          return undefined;
        }
      }),
      stderr: writeSink(stderr)
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("takt startup failed: config exploded");
  });

  test("validate command reports workflow readiness without starting service", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "takt-cli-validate-"));
    await writeFile(
      path.join(dir, "WORKFLOW.md"),
      [
        "---",
        "target:",
        "  name: Acme API",
        "  kind: go-service",
        "  repository: github.com/acme/api",
        "  verification:",
        "    - go test ./...",
        "  handoff: GitHub PR for review",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: demo",
        "  claim_state: In Progress",
        "  review_state: Needs Human",
        "  active_states:",
        "    - Ready",
        "    - In Progress",
        "github:",
        "  enabled: true",
        "  owner: acme",
        "  repo: api",
        "  token: $GITHUB_TOKEN",
        "runtime:",
        "  kind: host",
        "hooks:",
        "  after_create: git clone https://github.com/acme/api.git .",
        "  before_run: git fetch origin main && git rebase origin/main",
        "---",
        "Work on {{ issue.identifier }} for {{ target.name }}."
      ].join("\n")
    );
    const stdout: string[] = [];
    const code = await runCli({
      argv: ["validate"],
      cwd: dir,
      env: { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret" },
      serviceFactory: () => {
        throw new Error("validate should not start the service");
      },
      stdout: writeSink(stdout)
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Takt workflow validation:");
    expect(stdout.join("")).toContain("[OK] workflow:");
    expect(stdout.join("")).toContain("Summary: 0 error(s)");
  });
});

function fakeService(): CliService {
  return {
    async start() {
      return {};
    },
    async stop() {
      return undefined;
    }
  };
}

function writeSink(lines: string[]): Pick<NodeJS.WriteStream, "write"> {
  return {
    write(chunk: string | Uint8Array) {
      lines.push(String(chunk));
      return true;
    }
  } as Pick<NodeJS.WriteStream, "write">;
}

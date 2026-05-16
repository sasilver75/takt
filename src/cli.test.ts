import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SymphonyServiceOptions } from "./service.js";
import { parseCliArgs, runCli, startCli, type CliService } from "./cli.js";

describe("CLI", () => {
  test("parses positional workflow path and port override", () => {
    expect(parseCliArgs(["./examples/WORKFLOW.md", "--port", "8787"])).toEqual({
      workflowPath: "./examples/WORKFLOW.md",
      port: 8787,
      reconcileOnce: false
    });
    expect(parseCliArgs(["--port=0"])).toEqual({ workflowPath: null, port: 0, reconcileOnce: false });
    expect(parseCliArgs(["--reconcile-once"])).toEqual({ workflowPath: null, port: null, reconcileOnce: true });
    expect(() => parseCliArgs(["--port", "nope"])).toThrow("--port requires a non-negative integer");
    expect(() => parseCliArgs(["--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => parseCliArgs(["one.md", "two.md"])).toThrow("Unexpected positional argument: two.md");
  });

  test("uses ./WORKFLOW.md from cwd when no workflow path is provided", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-reconcile-"));
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-missing-"));
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
    expect(stderr.join("")).toContain("symphony startup failed:");
    expect(stderr.join("")).toContain("missing.md");
  });

  test("surfaces service startup failure cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-failure-"));
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
    expect(stderr.join("")).toContain("symphony startup failed: config exploded");
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

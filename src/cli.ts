#!/usr/bin/env node
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SymphonyService, type SymphonyServiceOptions } from "./service.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { errorMessage } from "./errors.js";
import { formatWorkflowDoctorReport, runWorkflowDoctor } from "./validation/doctor.js";

type CliArgs = {
  command: "serve" | "validate";
  workflowPath: string | null;
  port: number | null;
  reconcileOnce: boolean;
};

export type CliService = {
  start(): Promise<{ http?: { host: string; port: number } }>;
  stop(): Promise<void>;
};

export type StartCliOptions = {
  argv?: string[];
  cwd?: string;
  logger?: Logger;
  env?: Record<string, string | undefined>;
  serviceFactory?: (options: SymphonyServiceOptions) => CliService;
  installSignalHandlers?: boolean;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

export async function startCli(options: StartCliOptions = {}): Promise<CliService> {
  const args = parseCliArgs(options.argv ?? process.argv.slice(2));
  if (args.command !== "serve") throw new Error(`${args.command} does not start the Takt service`);
  const workflowPath = selectWorkflowPath(args.workflowPath, options.cwd);
  await access(workflowPath);
  const logger = options.logger ?? createLogger();
  const serviceOptions: SymphonyServiceOptions = {
    workflowPath,
    port: args.port,
    logger,
    runMode: args.reconcileOnce ? "reconcile_once" : "daemon",
    ...(options.env === undefined ? {} : { env: options.env })
  };
  const service = options.serviceFactory?.(serviceOptions) ?? new SymphonyService(serviceOptions);
  const started = await service.start();
  if (started.http) {
    logger.info("takt dashboard available", { url: `http://${started.http.host}:${started.http.port}/` });
  }
  if (args.reconcileOnce) {
    await service.stop();
    return service;
  }
  if (options.installSignalHandlers === false) return service;
  const shutdown = async (): Promise<void> => {
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return service;
}

export async function runCli(options: StartCliOptions = {}): Promise<number> {
  try {
    const args = parseCliArgs(options.argv ?? process.argv.slice(2));
    if (args.command === "validate") {
      const workflowPath = selectWorkflowPath(args.workflowPath, options.cwd);
      const report = await runWorkflowDoctor({ workflowPath, ...(options.env === undefined ? {} : { env: options.env }) });
      (options.stdout ?? process.stdout).write(formatWorkflowDoctorReport(report));
      return report.ok ? 0 : 1;
    }
    await startCli(options);
    return 0;
  } catch (error) {
    (options.stderr ?? process.stderr).write(`takt startup failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export function parseCliArgs(argv: string[]): CliArgs {
  let command: CliArgs["command"] = "serve";
  let workflowPath: string | null = null;
  let port: number | null = null;
  let reconcileOnce = false;
  let index = 0;
  if (argv[0] === "validate" || argv[0] === "doctor") {
    command = "validate";
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const raw = argv[++index];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--port requires a non-negative integer");
      port = parsed;
    } else if (arg?.startsWith("--port=")) {
      const parsed = Number(arg.slice("--port=".length));
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--port requires a non-negative integer");
      port = parsed;
    } else if (arg === "--reconcile-once") {
      reconcileOnce = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!workflowPath) {
      workflowPath = arg ?? null;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  if (command === "validate" && port !== null) throw new Error("validate does not support --port");
  if (command === "validate" && reconcileOnce) throw new Error("validate does not support --reconcile-once");
  return { command, workflowPath, port, reconcileOnce };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}

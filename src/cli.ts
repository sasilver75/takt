#!/usr/bin/env node
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SymphonyService, type SymphonyServiceOptions } from "./service.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { errorMessage } from "./errors.js";

type CliArgs = {
  workflowPath: string | null;
  port: number | null;
};

export type CliService = {
  start(): Promise<{ http?: { host: string; port: number } }>;
  stop(): Promise<void>;
};

export type StartCliOptions = {
  argv?: string[];
  cwd?: string;
  logger?: Logger;
  serviceFactory?: (options: SymphonyServiceOptions) => CliService;
  installSignalHandlers?: boolean;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

export async function startCli(options: StartCliOptions = {}): Promise<CliService> {
  const args = parseCliArgs(options.argv ?? process.argv.slice(2));
  const workflowPath = selectWorkflowPath(args.workflowPath, options.cwd);
  await access(workflowPath);
  const logger = options.logger ?? createLogger();
  const serviceOptions: SymphonyServiceOptions = { workflowPath, port: args.port, logger };
  const service = options.serviceFactory?.(serviceOptions) ?? new SymphonyService(serviceOptions);
  const started = await service.start();
  if (started.http) {
    logger.info("symphony dashboard available", { url: `http://${started.http.host}:${started.http.port}/` });
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
    await startCli(options);
    return 0;
  } catch (error) {
    (options.stderr ?? process.stderr).write(`symphony startup failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export function parseCliArgs(argv: string[]): CliArgs {
  let workflowPath: string | null = null;
  let port: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
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
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!workflowPath) {
      workflowPath = arg ?? null;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  return { workflowPath, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}

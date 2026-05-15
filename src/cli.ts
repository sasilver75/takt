#!/usr/bin/env node
import { access } from "node:fs/promises";
import { SymphonyService } from "./service.js";
import { selectWorkflowPath } from "./workflow/loader.js";
import { createLogger } from "./observability/logger.js";
import { errorMessage } from "./errors.js";

type CliArgs = {
  workflowPath: string | null;
  port: number | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workflowPath = selectWorkflowPath(args.workflowPath);
  await access(workflowPath);
  const logger = createLogger();
  const service = new SymphonyService({ workflowPath, port: args.port, logger });
  const started = await service.start();
  if (started.http) {
    logger.info("symphony dashboard available", { url: `http://${started.http.host}:${started.http.port}/` });
  }
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function parseArgs(argv: string[]): CliArgs {
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

main().catch((error) => {
  process.stderr.write(`symphony startup failed: ${errorMessage(error)}\n`);
  process.exit(1);
});

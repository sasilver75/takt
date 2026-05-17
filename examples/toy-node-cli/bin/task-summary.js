#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { formatSummary, parseTasks, summarizeTasks } from "../src/summary.js";

const input = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
const tasks = parseTasks(input);
process.stdout.write(`${formatSummary(summarizeTasks(tasks))}\n`);

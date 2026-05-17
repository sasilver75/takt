import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSummary, parseTasks, summarizeTasks } from "../src/summary.js";

test("parses task lines", () => {
  assert.deepEqual(parseTasks("Ship docs,open,high\nClose issue,done,normal\n"), [
    { title: "Ship docs", status: "open", priority: "high" },
    { title: "Close issue", status: "done", priority: "normal" }
  ]);
});

test("formats deterministic summary output", () => {
  const tasks = parseTasks("Ship docs,open,high\nClose issue,done,normal\n");
  assert.equal(formatSummary(summarizeTasks(tasks)), "total=2\nopen=1\ndone=1");
});

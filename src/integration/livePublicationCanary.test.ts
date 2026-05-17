import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  LIVE_PUBLICATION_CANARY_FLAG,
  LIVE_WORKFLOW_ENV,
  parsePublicationCanaryOptions,
  PUBLICATION_CANARY_FAILPOINTS,
  publicationCanaryUsage,
  selectPublicationCanaryCleanupState
} from "./livePublicationCanary.js";

describe("live publication canary options", () => {
  test("defaults to a skipped full matrix against the example workflow", () => {
    const options = parsePublicationCanaryOptions([], {}, "/repo");

    expect(options.enabled).toBe(false);
    expect(options.help).toBe(false);
    expect(options.workflowPath).toBe(path.resolve("/repo/examples/WORKFLOW.md"));
    expect(options.failpoints).toEqual([...PUBLICATION_CANARY_FAILPOINTS]);
    expect(options.keep).toBe(false);
    expect(options.cleanupState).toBeNull();
    expect(options.errors).toEqual([]);
  });

  test("selects workflow path from args before environment default", () => {
    const env = { [LIVE_PUBLICATION_CANARY_FLAG]: "1", [LIVE_WORKFLOW_ENV]: "from-env.md" };

    expect(parsePublicationCanaryOptions(["--workflow", "from-arg.md"], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-arg.md"));
    expect(parsePublicationCanaryOptions(["--", "from-pnpm.md"], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-pnpm.md"));
    expect(parsePublicationCanaryOptions([], env, "/repo").workflowPath).toBe(path.resolve("/repo/from-env.md"));
  });

  test("parses failpoints, keep, and cleanup-state flags", () => {
    const options = parsePublicationCanaryOptions(
      [
        "--failpoint",
        "branch_pushed",
        "--failpoints=evidence_comment_published,linear_comment_posted",
        "--failpoint",
        "branch_pushed",
        "--keep",
        "--cleanup-state",
        "Canceled",
        "--workflow=workflow.md"
      ],
      { [LIVE_PUBLICATION_CANARY_FLAG]: "1" },
      "/repo"
    );

    expect(options.enabled).toBe(true);
    expect(options.workflowPath).toBe(path.resolve("/repo/workflow.md"));
    expect(options.failpoints).toEqual(["branch_pushed", "evidence_comment_published", "linear_comment_posted"]);
    expect(options.keep).toBe(true);
    expect(options.cleanupState).toBe("Canceled");
    expect(options.errors).toEqual([]);
  });

  test("reports invalid failpoints and option values without throwing", () => {
    const options = parsePublicationCanaryOptions(["--failpoints", "branch_pushed,not_real", "--cleanup-state"], {}, "/repo");

    expect(options.failpoints).toEqual(["branch_pushed"]);
    expect(options.errors).toEqual(["unknown failpoint: not_real", "--cleanup-state requires a Linear workflow state name"]);
  });

  test("usage describes the live gate, failpoints, and cleanup behavior", () => {
    const usage = publicationCanaryUsage();

    expect(usage).toContain(LIVE_PUBLICATION_CANARY_FLAG);
    expect(usage).toContain("--keep");
    for (const failpoint of PUBLICATION_CANARY_FAILPOINTS) expect(usage).toContain(failpoint);
  });

  test("selects an existing workflow state for default cleanup", () => {
    expect(selectPublicationCanaryCleanupState(["Done", "Cancelled", "Duplicate"], ["Ready", "Needs Human", "Done"])).toBe("Done");
    expect(selectPublicationCanaryCleanupState(["Done", "Cancelled", "Duplicate"], ["Done", "Cancelled"])).toBe("Cancelled");
    expect(selectPublicationCanaryCleanupState(["Done"], ["done"], "DONE")).toBe("done");
    expect(selectPublicationCanaryCleanupState(["Cancelled"], ["Done"])).toBeNull();
  });
});

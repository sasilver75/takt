import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { Clock } from "../time.js";
import { systemClock } from "../time.js";
import type { WorkflowDefinition } from "../domain.js";
import { SymphonyError } from "../errors.js";

export function selectWorkflowPath(explicitPath: string | null | undefined, cwd = process.cwd()): string {
  return path.resolve(cwd, explicitPath ?? "WORKFLOW.md");
}

export async function loadWorkflow(workflowPath: string, clock: Clock = systemClock): Promise<WorkflowDefinition> {
  let text: string;
  try {
    text = await readFile(workflowPath, "utf8");
  } catch (error) {
    throw new SymphonyError("missing_workflow_file", `Workflow file not found: ${workflowPath}`, error);
  }

  const { configText, promptText } = splitFrontMatter(text);
  let config: Record<string, unknown> = {};
  if (configText !== null) {
    try {
      const parsed = YAML.parse(configText);
      if (parsed === null || parsed === undefined) {
        config = {};
      } else if (isPlainObject(parsed)) {
        config = parsed;
      } else {
        throw new SymphonyError("workflow_front_matter_not_a_map", "Workflow front matter must be a YAML map");
      }
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw new SymphonyError("workflow_parse_error", `Invalid workflow YAML front matter: ${workflowPath}`, error);
    }
  }

  return {
    config,
    prompt_template: promptText.trim(),
    path: path.resolve(workflowPath),
    loaded_at: clock.nowIso()
  };
}

function splitFrontMatter(text: string): { configText: string | null; promptText: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { configText: null, promptText: normalized };
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { configText: null, promptText: normalized };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      return {
        configText: lines.slice(1, index).join("\n"),
        promptText: lines.slice(index + 1).join("\n")
      };
    }
  }
  throw new SymphonyError("workflow_parse_error", "Workflow front matter was opened but not closed");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { Liquid } from "liquidjs";
import type { Issue, WorkflowDefinition } from "../domain.js";
import { SymphonyError } from "../errors.js";

const DEFAULT_PROMPT = "You are working on an issue from Linear.";

export async function renderIssuePrompt(
  workflow: WorkflowDefinition,
  issue: Issue,
  attempt: number | null,
  followupContext: string | null = null
): Promise<string> {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true
  });
  const template = workflow.prompt_template.trim() || DEFAULT_PROMPT;
  try {
    const rendered = await engine.parseAndRender(template, {
      issue: JSON.parse(JSON.stringify(issue)) as Issue,
      attempt,
      followup_context: followupContext
    });
    return appendFollowupContext(rendered, followupContext);
  } catch (error) {
    throw new SymphonyError("template_render_error", "Failed to render workflow prompt", error);
  }
}

export function continuationPrompt(turnNumber: number, maxTurns: number): string {
  return [
    `Continue the same Linear issue from the existing thread history.`,
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    `Inspect the current repo/workspace state, finish remaining work, run verification, and stop when the workflow-defined handoff is reached.`
  ].join("\n");
}

function appendFollowupContext(prompt: string, followupContext: string | null): string {
  const context = followupContext?.trim();
  if (!context) return prompt;
  return [prompt.trimEnd(), "", "Orchestrator follow-up context:", context].join("\n");
}

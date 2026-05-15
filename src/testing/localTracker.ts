import type { GraphqlToolExecutor, Issue, TrackerClient } from "../domain.js";

export class LocalTracker implements TrackerClient, GraphqlToolExecutor {
  private readonly issues = new Map<string, Issue>();

  constructor(issues: Issue[]) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return [...this.issues.values()].filter((issue) => issue.state === "Todo" || issue.state === "In Progress");
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const states = new Set(stateNames.map((state) => state.toLowerCase()));
    return [...this.issues.values()].filter((issue) => states.has(issue.state.toLowerCase()));
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return issueIds.map((id) => this.issues.get(id)).filter((issue): issue is Issue => Boolean(issue));
  }

  async executeGraphql(query: string, variables: Record<string, unknown> = {}): Promise<{ success: boolean; body?: unknown; error?: string }> {
    if (!query.includes("issueUpdate")) {
      return { success: false, error: "LocalTracker only supports issueUpdate in deterministic harness mode" };
    }
    const id = typeof variables.id === "string" ? variables.id : null;
    const state = typeof variables.state === "string" ? variables.state : "Human Review";
    if (!id || !this.issues.has(id)) return { success: false, error: "Unknown local issue id" };
    const current = this.issues.get(id);
    if (!current) return { success: false, error: "Unknown local issue id" };
    const updated = { ...current, state, updated_at: new Date().toISOString() };
    this.issues.set(id, updated);
    return {
      success: true,
      body: {
        data: {
          issueUpdate: {
            success: true,
            issue: updated
          }
        }
      }
    };
  }

  getIssue(id: string): Issue | null {
    return this.issues.get(id) ?? null;
  }
}

import type { Issue, TrackerClient } from "../domain.js";

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ABC-1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

export class FakeTracker implements TrackerClient {
  candidateCalls = 0;
  statesCalls = 0;
  stateRefreshCalls = 0;

  constructor(
    public candidates: Issue[] = [],
    public byStates: Issue[] = [],
    public byIds: Issue[] = []
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.candidateCalls += 1;
    return this.candidates;
  }

  async fetchIssuesByStates(_stateNames: string[]): Promise<Issue[]> {
    this.statesCalls += 1;
    return this.byStates;
  }

  async fetchIssueStatesByIds(_issueIds: string[]): Promise<Issue[]> {
    this.stateRefreshCalls += 1;
    return this.byIds;
  }
}

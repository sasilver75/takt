import type { Issue, TrackerClient, SymphonyConfig, BlockerRef } from "../domain.js";
import { SymphonyError } from "../errors.js";

type FetchLike = typeof fetch;

export class LinearTrackerClient implements TrackerClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private getConfig: () => SymphonyConfig,
    fetchImpl: FetchLike = fetch
  ) {
    this.fetchImpl = fetchImpl;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const config = this.getConfig();
    const query = `
      query SymphonyCandidateIssues($projectSlug: String!, $states: [String!], $after: String) {
        issues(
          first: 50
          after: $after
          filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $states } } }
          orderBy: createdAt
        ) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const all: Issue[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await this.graphql(query, {
        projectSlug: config.tracker.project_slug,
        states: config.tracker.active_states,
        after
      });
      const page = readConnection(body, ["data", "issues"]);
      all.push(...page.nodes.map(normalizeIssue));
      if (!page.hasNextPage) break;
      if (!page.endCursor) throw new SymphonyError("linear_missing_end_cursor", "Linear pagination reported next page without endCursor");
      after = page.endCursor;
    }
    return all;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const query = `
      query SymphonyIssuesByStates($projectSlug: String!, $states: [String!], $after: String) {
        issues(
          first: 50
          after: $after
          filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $states } } }
          orderBy: createdAt
        ) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const all: Issue[] = [];
    let after: string | null = null;
    for (;;) {
      const body = await this.graphql(query, {
        projectSlug: this.getConfig().tracker.project_slug,
        states: stateNames,
        after
      });
      const page = readConnection(body, ["data", "issues"]);
      all.push(...page.nodes.map(normalizeIssue));
      if (!page.hasNextPage) break;
      if (!page.endCursor) throw new SymphonyError("linear_missing_end_cursor", "Linear pagination reported next page without endCursor");
      after = page.endCursor;
    }
    return all;
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const query = `
      query SymphonyIssueStates($ids: [ID!]) {
        issues(first: 100, filter: { id: { in: $ids } }) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `;
    const body = await this.graphql(query, { ids: issueIds });
    const nodes = readArrayAt(body, ["data", "issues", "nodes"]);
    return nodes.map(normalizeIssue);
  }

  async executeGraphql(query: string, variables: Record<string, unknown> = {}): Promise<{ success: boolean; body?: unknown; error?: string }> {
    try {
      validateSingleOperation(query);
      const body = await this.graphql(query, variables, { allowGraphqlErrors: true });
      const errors = body && typeof body === "object" && "errors" in body ? (body as { errors?: unknown }).errors : undefined;
      return { success: !errors, body };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async transitionIssue(issue: Issue, stateName: string): Promise<Issue> {
    const stateId = await this.workflowStateIdForIssue(issue.id, stateName);
    const mutation = `
      mutation SymphonyIssueTransition($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }
    `;
    const body = await this.graphql(mutation, { id: issue.id, stateId });
    if (valueAtPath(body, ["data", "issueUpdate", "success"]) !== true) {
      throw new SymphonyError("linear_state_transition_failed", `Linear issueUpdate did not report success for state: ${stateName}`);
    }
    const updated = valueAtPath(body, ["data", "issueUpdate", "issue"]);
    const normalized = normalizeIssue(updated);
    if (normalizeStateName(normalized.state) !== normalizeStateName(stateName)) {
      throw new SymphonyError("linear_state_transition_failed", `Linear issueUpdate returned state ${normalized.state}, expected ${stateName}`);
    }
    return normalized;
  }

  async commentOnIssue(issue: Issue, bodyText: string): Promise<void> {
    const mutation = `
      mutation SymphonyIssueComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;
    await this.graphql(mutation, { issueId: issue.id, body: bodyText });
  }

  private async workflowStateIdForIssue(issueId: string, stateName: string): Promise<string> {
    const issueQuery = `
      query SymphonyIssueTeam($id: String!) {
        issue(id: $id) { id team { id } }
      }
    `;
    const issueBody = await this.graphql(issueQuery, { id: issueId });
    const teamId = nullableString(valueAtPath(issueBody, ["data", "issue", "team", "id"]));
    if (!teamId) throw new SymphonyError("linear_unknown_payload", "Linear issue team id was missing");
    const statesQuery = `
      query SymphonyWorkflowState($teamId: ID!, $name: String!) {
        workflowStates(first: 50, filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
          nodes { id name }
        }
      }
    `;
    const statesBody = await this.graphql(statesQuery, { teamId, name: stateName });
    const nodes = readArrayAt(statesBody, ["data", "workflowStates", "nodes"]);
    const state = nodes.find((node) => node && typeof node === "object" && (node as Record<string, unknown>).name === stateName) as
      | Record<string, unknown>
      | undefined;
    const stateId = nullableString(state?.id);
    if (!stateId) throw new SymphonyError("linear_state_not_found", `Linear workflow state not found: ${stateName}`);
    return stateId;
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    options: { allowGraphqlErrors?: boolean } = {}
  ): Promise<unknown> {
    const config = this.getConfig();
    if (!config.tracker.api_key) throw new SymphonyError("missing_tracker_api_key", "Linear API key is missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await this.fetchImpl(config.tracker.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: config.tracker.api_key
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
    } catch (error) {
      throw new SymphonyError("linear_api_request", "Linear API request failed", error);
    } finally {
      clearTimeout(timeout);
    }
    const rawBody = await response.text().catch((error: unknown) => {
      throw new SymphonyError("linear_unknown_payload", "Linear response could not be read", error);
    });
    let body: unknown = null;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch (error) {
      if (!response.ok) throw new SymphonyError("linear_api_status", `Linear API returned HTTP ${response.status}: invalid JSON response`, error);
      throw new SymphonyError("linear_unknown_payload", "Linear returned invalid JSON", error);
    }
    if (!response.ok) throw new SymphonyError("linear_api_status", `Linear API returned HTTP ${response.status}: ${linearErrorSummary(body)}`);
    if (!options.allowGraphqlErrors && body && typeof body === "object" && "errors" in body) {
      throw new SymphonyError("linear_graphql_errors", "Linear returned GraphQL errors", body);
    }
    return body;
  }
}

export function normalizeIssue(raw: unknown): Issue {
  if (!raw || typeof raw !== "object") throw new SymphonyError("linear_unknown_payload", "Issue payload is not an object");
  const data = raw as Record<string, unknown>;
  const state = objectAt(data, "state");
  const labels = readConnectionOptional(data, ["labels"]).nodes;
  const relations = readConnectionOptional(data, ["inverseRelations"]).nodes;
  return {
    id: requiredString(data, "id"),
    identifier: requiredString(data, "identifier"),
    title: requiredString(data, "title"),
    description: nullableString(data.description),
    priority: Number.isInteger(data.priority) ? Number(data.priority) : null,
    state: requiredString(state, "name"),
    branch_name: nullableString(data.branchName ?? data.branch_name),
    url: nullableString(data.url),
    labels: labels
      .map((label) => (label && typeof label === "object" ? (label as Record<string, unknown>).name : null))
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.toLowerCase()),
    blocked_by: relations.map(normalizeBlocker).filter((blocker): blocker is BlockerRef => blocker !== null),
    created_at: nullableIso(data.createdAt ?? data.created_at),
    updated_at: nullableIso(data.updatedAt ?? data.updated_at)
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
`;

function normalizeBlocker(raw: unknown): BlockerRef | null {
  if (!raw || typeof raw !== "object") return null;
  const relation = raw as Record<string, unknown>;
  if (relation.type !== "blocks") return null;
  const issue = objectAt(relation, "issue");
  const state = objectAt(issue, "state");
  return {
    id: nullableString(issue.id),
    identifier: nullableString(issue.identifier),
    state: nullableString(state.name)
  };
}

function readConnection(body: unknown, path: string[]): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } {
  const conn = valueAtPath(body, path);
  if (!conn || typeof conn !== "object") throw new SymphonyError("linear_unknown_payload", `Missing connection ${path.join(".")}`);
  const nodes = readArrayAt(conn, ["nodes"]);
  const pageInfo = objectAt(conn as Record<string, unknown>, "pageInfo");
  return {
    nodes,
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: nullableString(pageInfo.endCursor)
  };
}

function readConnectionOptional(root: Record<string, unknown>, path: string[]): { nodes: unknown[] } {
  const conn = valueAtPath(root, path);
  if (!conn || typeof conn !== "object") return { nodes: [] };
  const nodes = (conn as Record<string, unknown>).nodes;
  return { nodes: Array.isArray(nodes) ? nodes : [] };
}

function readArrayAt(root: unknown, path: string[]): unknown[] {
  const value = valueAtPath(root, path);
  if (!Array.isArray(value)) throw new SymphonyError("linear_unknown_payload", `Expected array at ${path.join(".")}`);
  return value;
}

function valueAtPath(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(root: Record<string, unknown>, key: string): string {
  const value = root[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new SymphonyError("linear_unknown_payload", `Missing issue.${key}`);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeStateName(value: string): string {
  return value.toLowerCase();
}

function linearErrorSummary(body: unknown): string {
  if (!body || typeof body !== "object" || !("errors" in body)) return "no error details";
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return "no error details";
  const messages = errors
    .map((error) => (error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message) : null))
    .filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.slice(0, 3).join("; ") : "no error details";
}

function nullableIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function validateSingleOperation(query: string): void {
  const stripped = query.replace(/#[^\n]*/g, "").replace(/"([^"\\]|\\.)*"/g, "\"\"");
  const operations = stripped.match(/\b(query|mutation|subscription)\b/g) ?? [];
  if (!query.trim()) throw new SymphonyError("linear_graphql_invalid_input", "GraphQL query is required");
  if (operations.length > 1) throw new SymphonyError("linear_graphql_invalid_input", "GraphQL tool accepts exactly one operation");
}

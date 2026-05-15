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
    if (!response.ok) throw new SymphonyError("linear_api_status", `Linear API returned HTTP ${response.status}`);
    const body = await response.json().catch((error: unknown) => {
      throw new SymphonyError("linear_unknown_payload", "Linear returned invalid JSON", error);
    });
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

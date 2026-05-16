import type { SymphonyConfig } from "../domain.js";
import { SymphonyError } from "../errors.js";

export type FetchLike = typeof fetch;
export type GitHubMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class GitHubApiClient {
  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async request<T = unknown>(method: GitHubMethod, route: string, body?: unknown): Promise<T> {
    const config = this.getConfig().github;
    if (!config.enabled) throw new SymphonyError("github_disabled", "GitHub integration is disabled");
    if (!config.owner || !config.repo || !config.token) throw new SymphonyError("github_not_configured", "GitHub integration is not fully configured");
    const response = await this.fetchImpl(`${config.api_endpoint.replace(/\/$/, "")}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String((payload as { message?: unknown }).message) : response.statusText;
      throw new SymphonyError("github_api_error", `GitHub API ${method} ${route} failed: ${message}`, { status: response.status, method, route, payload });
    }
    return payload as T;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const config = this.getConfig().github;
    if (!config.enabled) throw new SymphonyError("github_disabled", "GitHub integration is disabled");
    if (!config.token) throw new SymphonyError("github_not_configured", "GitHub integration is not fully configured");
    const response = await this.fetchImpl(graphqlEndpoint(config.api_endpoint), {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String((payload as { message?: unknown }).message) : response.statusText;
      throw new SymphonyError("github_api_error", `GitHub GraphQL request failed: ${message}`, { status: response.status, payload });
    }
    if (payload && typeof payload === "object" && Array.isArray((payload as { errors?: unknown }).errors)) {
      throw new SymphonyError("github_api_error", `GitHub GraphQL request failed: ${JSON.stringify((payload as { errors: unknown }).errors).slice(0, 500)}`);
    }
    return payload as T;
  }
}

function graphqlEndpoint(apiEndpoint: string): string {
  const normalized = apiEndpoint.replace(/\/$/, "");
  if (normalized.endsWith("/api/v3")) return `${normalized.slice(0, -"/api/v3".length)}/api/graphql`;
  if (normalized.endsWith("/graphql")) return normalized;
  return `${normalized}/graphql`;
}

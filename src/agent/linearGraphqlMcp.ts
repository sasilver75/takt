import type { Issue, SymphonyConfig } from "../domain.js";

const SECRET_ENV_KEY = /(^|[_-])(token|secret|password|authorization|credential|pat)($|[_-])|api[_-]?key/i;
const MCP_BEARER_ENV_VAR = "TAKT_LINEAR_MCP_TOKEN";

export type LinearGraphqlMcpBridgeConfig = {
  url: string;
  token?: string | undefined;
};

export type LinearMcpLaunch = {
  command: string;
  env: NodeJS.ProcessEnv;
  configuredUrl: string | null;
};

export async function prepareLinearGraphqlMcp(
  config: SymphonyConfig,
  _workspacePath: string,
  issue: Issue | null,
  bridge: LinearGraphqlMcpBridgeConfig | null
): Promise<LinearMcpLaunch> {
  const env = sanitizedCodexEnv(process.env, config, {
    TAKT_LINEAR_PROJECT_SLUG: config.tracker.project_slug ?? "",
    TAKT_LINEAR_CURRENT_ISSUE_ID: issue?.id ?? "",
    TAKT_LINEAR_CURRENT_ISSUE_IDENTIFIER: issue?.identifier ?? ""
  });
  if (!config.codex.linear_graphql_mcp.enabled || !bridge) {
    return { command: config.codex.command, env, configuredUrl: null };
  }
  if (bridge.token) env[MCP_BEARER_ENV_VAR] = bridge.token;
  return {
    command: appendMcpConfig(config.codex.command, config.codex.linear_graphql_mcp.server_name, bridge.url, bridge.token ? MCP_BEARER_ENV_VAR : null),
    env,
    configuredUrl: bridge.url
  };
}

export function appendMcpConfig(command: string, serverName: string, url: string, bearerTokenEnvVar: string | null = null): string {
  const urlConfig = `mcp_servers.${serverName}.url=${JSON.stringify(url)}`;
  const authConfig = bearerTokenEnvVar ? ` -c ${shellQuote(`mcp_servers.${serverName}.bearer_token_env_var=${JSON.stringify(bearerTokenEnvVar)}`)}` : "";
  return `${command} -c ${shellQuote(urlConfig)}${authConfig}`;
}

export function sanitizedCodexEnv(
  baseEnv: NodeJS.ProcessEnv,
  config: Pick<SymphonyConfig, "tracker" | "github">,
  extras: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const secretValues = [config.tracker.api_key, config.github.token].filter((value): value is string => typeof value === "string" && value.length > 8);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEY.test(key)) continue;
    if (secretValues.some((secret) => value.includes(secret))) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

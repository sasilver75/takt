export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
};

export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type WorkflowDefinition = {
  config: Record<string, unknown>;
  prompt_template: string;
  path: string;
  loaded_at: string;
};

export type SymphonyConfig = {
  workflowPath: string;
  workflowDir: string;
  tracker: {
    kind: "linear";
    endpoint: string;
    api_key: string | null;
    project_slug: string | null;
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  runtime: RuntimeConfig;
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  codex: {
    command: string;
    approval_policy: unknown | null;
    thread_sandbox: unknown | null;
    turn_sandbox_policy: unknown | null;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
    linear_graphql_mcp: {
      enabled: boolean;
      server_name: string;
    };
  };
  server: {
    port: number | null;
    host: string;
  };
};

export type RuntimeConfig =
  | {
      kind: "host";
    }
  | {
      kind: "docker";
      docker: DockerRuntimeConfig;
    };

export type DockerRuntimeConfig = {
  image: string;
  workspace_mount: string;
  codex_home: string | null;
  codex_home_mount: string;
  mcp_host: string;
  mcp_bind_host: string;
  add_host_gateway: boolean;
  network: string | null;
  memory: string | null;
  cpus: string | null;
  extra_args: string[];
  environment: Record<string, string>;
};

export type Workspace = {
  path: string;
  workspace_key: string;
  created_now: boolean;
};

export type TokenTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type CodexRuntimeEvent = {
  event: string;
  timestamp: string;
  codex_app_server_pid?: number | null;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  message?: string | null;
  usage?: Partial<TokenTotals> | null;
  absolute_usage?: Partial<TokenTotals> | null;
  rate_limits?: unknown;
  raw?: unknown;
};

export type RunResult =
  | { ok: true; reason: "normal"; workspace_path: string; runtime_seconds: number }
  | { ok: false; reason: RunFailureReason; error: string; workspace_path?: string; runtime_seconds: number };

export type RunFailureReason =
  | "workspace_error"
  | "hook_error"
  | "prompt_error"
  | "startup_failed"
  | "turn_failed"
  | "turn_timeout"
  | "turn_input_required"
  | "response_timeout"
  | "stalled"
  | "cancelled"
  | "tracker_error"
  | "unknown";

export type TrackerClient = {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
};

export type GraphqlToolExecutor = {
  executeGraphql(query: string, variables?: Record<string, unknown>): Promise<{ success: boolean; body?: unknown; error?: string }>;
};

export type RunningEntry = {
  issue: Issue;
  identifier: string;
  started_at_ms: number;
  started_at: string;
  retry_attempt: number | null;
  workspace_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: number | null;
  last_codex_event: string | null;
  last_codex_timestamp_ms: number | null;
  last_codex_timestamp: string | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
  terminate(reason: string): Promise<void> | void;
};

export type RetryEntry = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: NodeJS.Timeout | null;
  error: string | null;
};

export type RuntimeState = {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: TokenTotals & { seconds_running: number };
  codex_rate_limits: unknown;
  recent_events: RuntimeEvent[];
  issue_history: Map<string, IssueDebugRecord>;
};

export type RuntimeEvent = {
  at: string;
  event: string;
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string | null;
  message?: string | null;
};

export type IssueDebugRecord = {
  issue_id: string;
  issue_identifier: string;
  workspace_path: string | null;
  restart_count: number;
  last_error: string | null;
  recent_events: RuntimeEvent[];
  tracked: Record<string, unknown>;
};

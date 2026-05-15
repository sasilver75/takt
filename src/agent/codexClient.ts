import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SymphonyConfig, CodexRuntimeEvent, GraphqlToolExecutor, Issue } from "../domain.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { prepareLinearGraphqlMcp, type LinearGraphqlMcpBridgeConfig } from "./linearGraphqlMcp.js";

type JsonObject = Record<string, unknown>;

export type CodexClientOptions = {
  config: SymphonyConfig;
  workspacePath: string;
  logger: Logger;
  onEvent: (event: CodexRuntimeEvent) => void;
  linearTool?: GraphqlToolExecutor | null | undefined;
  issue?: Issue | null | undefined;
  linearBridge?: LinearGraphqlMcpBridgeConfig | null | undefined;
};

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private threadId: string | null = null;
  private stopped = false;

  constructor(private readonly options: CodexClientOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    const launch = await prepareLinearGraphqlMcp(
      this.options.config,
      this.options.workspacePath,
      this.options.issue ?? null,
      this.options.linearBridge ?? null
    );
    if (launch.configuredUrl) {
      this.emit("linear_graphql_mcp_configured", { message: this.options.config.codex.linear_graphql_mcp.server_name });
    }
    this.child = spawn("bash", ["-lc", launch.command], {
      cwd: this.options.workspacePath,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr.on("data", (chunk) => {
      this.options.logger.debug("codex stderr", { message: redactText(chunk.toString("utf8"), this.secretValues()).slice(0, 1200) });
    });
    this.child.on("exit", (code, signal) => {
      if (this.stopped) return;
      const error = new SymphonyError("port_exit", `Codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("turn_ended_with_error", { message: error.message });
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
  }

  async startThread(): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: this.options.workspacePath,
      approvalPolicy: this.options.config.codex.approval_policy,
      sandbox: this.options.config.codex.thread_sandbox,
      serviceName: "symphony",
      ephemeral: false,
      baseInstructions: [
        "You are running under Symphony, an automated software production orchestrator.",
        this.options.config.codex.linear_graphql_mcp.enabled
          ? `Use the linear_graphql tool from the ${this.options.config.codex.linear_graphql_mcp.server_name} MCP server for Linear reads, comments, and issue state changes. Do not use other Linear integrations, do not use raw Linear credentials from disk, and do not inspect Symphony harness internals.`
          : "Use only workflow-approved tools for Linear handoff, never read raw Linear credentials from disk, and do not inspect Symphony harness internals."
      ].join("\n")
    })) as JsonObject;
    const thread = result.thread as JsonObject | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) throw new SymphonyError("response_error", "thread/start response did not include thread.id");
    this.threadId = threadId;
    return threadId;
  }

  async runTurn(input: string): Promise<{ turnId: string; status: string }> {
    if (!this.threadId) throw new SymphonyError("response_error", "Thread has not been started");
    const result = (await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input, text_elements: [] }],
      cwd: this.options.workspacePath,
      approvalPolicy: this.options.config.codex.approval_policy,
      sandboxPolicy: this.options.config.codex.turn_sandbox_policy
    }, this.options.config.codex.turn_timeout_ms)) as JsonObject;
    const turn = result.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId) throw new SymphonyError("response_error", "turn/start response did not include turn.id");
    this.emit("session_started", { thread_id: this.threadId, turn_id: turnId, session_id: `${this.threadId}-${turnId}` });
    const completed = await this.waitForTurn(turnId);
    return { turnId, status: completed };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SymphonyError("cancelled", "Codex client stopped"));
    }
    this.pending.clear();
    this.child?.kill("SIGTERM");
  }

  private request(method: string, params: unknown, timeoutMs = this.options.config.codex.read_timeout_ms): Promise<unknown> {
    if (!this.child) throw new SymphonyError("codex_not_found", "Codex app-server is not running");
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SymphonyError("response_timeout", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private async waitForTurn(turnId: string): Promise<string> {
    const deadline = Date.now() + this.options.config.codex.turn_timeout_ms;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() > deadline) reject(new SymphonyError("turn_timeout", `Turn ${turnId} timed out`));
        else setTimeout(check, 100);
      };
      const unsubscribe = this.onTurnTerminal(turnId, (status, error) => {
        unsubscribe();
        if (error) reject(error);
        else resolve(status);
      });
      check();
    });
  }

  private readonly turnWaiters = new Map<string, Set<(status: string, error?: Error) => void>>();

  private onTurnTerminal(turnId: string, callback: (status: string, error?: Error) => void): () => void {
    const set = this.turnWaiters.get(turnId) ?? new Set();
    set.add(callback);
    this.turnWaiters.set(turnId, set);
    return () => set.delete(callback);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch (error) {
      this.emit("malformed", { message: errorMessage(error) });
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      this.resolveResponse(message);
      return;
    }
    if ("id" in message && typeof message.method === "string") {
      void this.resolveServerRequest(message);
      return;
    }
    if (typeof message.method === "string") this.handleNotification(message);
    else this.emit("other_message", { raw: message });
  }

  private resolveResponse(message: JsonObject): void {
    const id = message.id as string | number;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ("error" in message) pending.reject(new SymphonyError("response_error", JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private async resolveServerRequest(message: JsonObject): Promise<void> {
    const id = message.id as string | number;
    const method = String(message.method);
    let result: unknown;
    try {
      if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
        result = { decision: "acceptForSession" };
        this.emit("approval_auto_approved", { message: method });
      } else if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
        result = { decision: "acceptForSession" };
        this.emit("approval_auto_approved", { message: method });
      } else if (method === "item/tool/requestUserInput") {
        result = { answers: {} };
        this.emit("turn_input_required", { message: "user input request failed by policy" });
      } else if (method === "mcpServer/elicitation/request") {
        result = { action: "accept", content: {}, _meta: null };
        this.emit("mcp_elicitation_auto_accepted", { message: mcpElicitationMessage(message.params) });
      } else if (method === "item/tool/call") {
        result = await this.handleDynamicTool(message.params as JsonObject);
      } else {
        result = { contentItems: [{ type: "inputText", text: `Unsupported client request: ${method}` }], success: false };
        this.emit("unsupported_tool_call", { message: method });
      }
    } catch (error) {
      result = { contentItems: [{ type: "inputText", text: errorMessage(error) }], success: false };
    }
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private async handleDynamicTool(params: JsonObject): Promise<unknown> {
    const name = typeof params.tool === "string" ? params.tool : typeof params.name === "string" ? params.name : "";
    if (name !== "linear_graphql") {
      return { contentItems: [{ type: "inputText", text: `Unsupported tool: ${name}` }], success: false };
    }
    const parsed = parseLinearToolArgs(params.arguments);
    if (!this.options.linearTool) {
      return { contentItems: [{ type: "inputText", text: "linear_graphql is unavailable for this session" }], success: false };
    }
    const result = await this.options.linearTool.executeGraphql(parsed.query, parsed.variables);
    this.emit("linear_graphql_tool_call", { message: `dynamic success=${result.success}` });
    return { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: result.success };
  }

  private handleNotification(message: JsonObject): void {
    const method = String(message.method);
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as JsonObject;
    const threadId = typeof params.threadId === "string" ? params.threadId : this.threadId;
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as JsonObject) : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : null;
    const sessionId = threadId && turnId ? `${threadId}-${turnId}` : null;
    const usage = method === "thread/tokenUsage/updated" ? extractUsage(params.tokenUsage) : null;
    const rateLimits = method === "account/rateLimits/updated" ? params.rateLimits : undefined;
    const mcpToolCall = findLinearMcpToolCall(params, this.options.config.codex.linear_graphql_mcp.server_name);
    this.emit(method, {
      thread_id: threadId,
      turn_id: turnId,
      session_id: sessionId,
      absolute_usage: usage,
      rate_limits: rateLimits,
      raw: sanitizeNotificationRaw(method, params, this.secretValues())
    });
    if (mcpToolCall) {
      this.emit("linear_graphql_tool_call", {
        thread_id: threadId,
        turn_id: turnId,
        session_id: sessionId,
        message: mcpToolCall
      });
    }
    if (method === "turn/completed" && turnId) {
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      const waiters = this.turnWaiters.get(turnId);
      for (const waiter of waiters ?? []) {
        if (status === "completed") waiter(status);
        else waiter(status, new SymphonyError(status === "interrupted" ? "turn_cancelled" : "turn_failed", `Turn ended with status ${status}`));
      }
    }
    if (method === "error" && turnId) {
      const waiters = this.turnWaiters.get(turnId);
      for (const waiter of waiters ?? []) waiter("failed", new SymphonyError("turn_failed", JSON.stringify(params.error ?? params)));
    }
  }

  private emit(event: string, extra: Partial<CodexRuntimeEvent>): void {
    const safeExtra = redactSecrets(extra, this.secretValues()) as Partial<CodexRuntimeEvent>;
    this.options.onEvent({
      event,
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this.pid,
      ...safeExtra
    });
  }

  private secretValues(): string[] {
    return [this.options.linearBridge?.token, this.options.config.tracker.api_key].filter(
      (value): value is string => typeof value === "string" && value.length > 8
    );
  }
}

function extractUsage(value: unknown): { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const input = numberFrom(data.input_tokens ?? data.inputTokens ?? data.input);
  const output = numberFrom(data.output_tokens ?? data.outputTokens ?? data.output);
  const total = numberFrom(data.total_tokens ?? data.totalTokens ?? data.total);
  return {
    ...(input === null ? {} : { input_tokens: input }),
    ...(output === null ? {} : { output_tokens: output }),
    ...(total === null ? {} : { total_tokens: total })
  };
}

function numberFrom(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function sanitizeNotificationRaw(method: string, params: JsonObject, secretValues: string[]): unknown {
  if (method !== "item/mcpToolCall/progress" && method !== "item/started" && method !== "item/completed") return redactSecrets(params, secretValues);
  const toolCall = findAnyMcpToolCall(params);
  if (!toolCall) return redactSecrets(params, secretValues);
  return redactSecrets({
    threadId: typeof params.threadId === "string" ? params.threadId : undefined,
    turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    mcpToolCall: {
      server: toolCall.server,
      tool: toolCall.tool,
      status: toolCall.status,
      success: toolCall.success
    }
  }, secretValues);
}

function redactSecrets(value: unknown, secretValues: string[]): unknown {
  if (secretValues.length === 0) return value;
  if (typeof value === "string") return redactText(value, secretValues);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, secretValues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactSecrets(entry, secretValues);
    return out;
  }
  return value;
}

function redactText(value: string, secretValues: string[]): string {
  return secretValues.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
}

function findLinearMcpToolCall(params: unknown, serverName: string): string | null {
  const toolCall = findAnyMcpToolCall(params);
  if (!toolCall) return null;
  if (toolCall.tool !== "linear_graphql") return null;
  if (toolCall.server && toolCall.server !== serverName) return null;
  return `mcp server=${toolCall.server ?? serverName} tool=linear_graphql status=${toolCall.status ?? "unknown"} success=${toolCall.success ?? "unknown"}`;
}

function findAnyMcpToolCall(value: unknown): { server?: string; tool?: string; status?: string; success?: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.tool === "string" && (typeof record.server === "string" || record.type === "mcpToolCall")) {
    return {
      tool: record.tool,
      ...(typeof record.server === "string" ? { server: record.server } : {}),
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.success === "boolean" ? { success: record.success } : {})
    };
  }
  for (const nested of Object.values(record)) {
    const found = findAnyMcpToolCall(nested);
    if (found) return found;
  }
  return null;
}

function mcpElicitationMessage(params: unknown): string {
  if (!params || typeof params !== "object") return "mcp elicitation";
  const record = params as Record<string, unknown>;
  const server = typeof record.serverName === "string" ? record.serverName : "unknown";
  const mode = typeof record.mode === "string" ? record.mode : "unknown";
  return `server=${server} mode=${mode}`;
}

function parseLinearToolArgs(value: unknown): { query: string; variables: Record<string, unknown> } {
  if (typeof value === "string") return { query: value, variables: {} };
  if (!value || typeof value !== "object") throw new SymphonyError("linear_graphql_invalid_input", "linear_graphql arguments must be an object or query string");
  const data = value as Record<string, unknown>;
  if (typeof data.query !== "string" || !data.query.trim()) throw new SymphonyError("linear_graphql_invalid_input", "linear_graphql query is required");
  if (data.variables !== undefined && (!data.variables || typeof data.variables !== "object" || Array.isArray(data.variables))) {
    throw new SymphonyError("linear_graphql_invalid_input", "linear_graphql variables must be an object");
  }
  return { query: data.query, variables: (data.variables as Record<string, unknown> | undefined) ?? {} };
}

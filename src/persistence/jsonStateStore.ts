import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DurableStateSnapshot, DurableStateStore, IssueDebugRecord, RunAttemptRecord, RuntimeEvent, SymphonyConfig } from "../domain.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../observability/logger.js";

export class JsonDurableStateStore implements DurableStateStore {
  constructor(
    private readonly getConfig: () => SymphonyConfig,
    private readonly logger: Logger
  ) {}

  async load(): Promise<DurableStateSnapshot | null> {
    const filePath = this.filePath();
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      this.logger.warn("durable state read failed", { path: filePath, error: errorMessage(error) });
      return null;
    }
    try {
      return normalizeSnapshot(JSON.parse(raw) as unknown, this.getConfig().observability);
    } catch (error) {
      this.logger.warn("durable state parse failed", { path: filePath, error: errorMessage(error) });
      return null;
    }
  }

  async save(snapshot: DurableStateSnapshot): Promise<void> {
    const filePath = this.filePath();
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, filePath);
  }

  filePath(): string {
    return path.join(path.resolve(this.getConfig().workspace.root), ".symphony", "state.json");
  }
}

function normalizeSnapshot(value: unknown, observability: SymphonyConfig["observability"]): DurableStateSnapshot {
  if (!value || typeof value !== "object") throw new Error("state snapshot must be an object");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error(`unsupported durable state schema_version: ${String(record.schema_version)}`);
  return {
    schema_version: 1,
    saved_at: stringOrNow(record.saved_at),
    retry_attempts: array(record.retry_attempts).map((entry) => normalizeRetry(entry)).filter((entry): entry is NonNullable<ReturnType<typeof normalizeRetry>> => Boolean(entry)),
    completed_issue_ids: array(record.completed_issue_ids).filter((entry): entry is string => typeof entry === "string"),
    issue_history: array(record.issue_history)
      .map((entry) => normalizeIssueRecord(entry, observability))
      .filter((entry): entry is IssueDebugRecord => Boolean(entry)),
    recent_events: array(record.recent_events)
      .map((entry) => normalizeEvent(entry))
      .filter((entry): entry is RuntimeEvent => Boolean(entry))
      .slice(-observability.recent_event_limit),
    codex_totals: normalizeCodexTotals(record.codex_totals),
    codex_rate_limits: record.codex_rate_limits ?? null
  };
}

function normalizeRetry(value: unknown): DurableStateSnapshot["retry_attempts"][number] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const issueId = stringOrNull(record.issue_id);
  const identifier = stringOrNull(record.identifier);
  const attempt = positiveIntegerOrNull(record.attempt);
  const dueAtMs = finiteNumberOrNull(record.due_at_ms);
  if (!issueId || !identifier || !attempt || dueAtMs === null) return null;
  return {
    issue_id: issueId,
    identifier,
    attempt,
    due_at_ms: dueAtMs,
    error: stringOrNull(record.error),
    context: stringOrNull(record.context)
  };
}

function normalizeIssueRecord(value: unknown, observability: SymphonyConfig["observability"]): IssueDebugRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const issueId = stringOrNull(record.issue_id);
  const issueIdentifier = stringOrNull(record.issue_identifier);
  if (!issueId || !issueIdentifier) return null;
  const tracked = record.tracked && typeof record.tracked === "object" && !Array.isArray(record.tracked) ? (record.tracked as Record<string, unknown>) : {};
  return {
    issue_id: issueId,
    issue_identifier: issueIdentifier,
    workspace_path: stringOrNull(record.workspace_path),
    restart_count: nonNegativeInteger(record.restart_count),
    last_error: stringOrNull(record.last_error),
    run_attempts: array(record.run_attempts)
      .map((entry) => normalizeRunAttempt(entry))
      .filter((entry): entry is RunAttemptRecord => Boolean(entry))
      .slice(-observability.run_attempt_limit),
    recent_events: array(record.recent_events)
      .map((entry) => normalizeEvent(entry))
      .filter((entry): entry is RuntimeEvent => Boolean(entry))
      .slice(-observability.issue_event_limit),
    tracked
  };
}

function normalizeRunAttempt(value: unknown): RunAttemptRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const startedAt = stringOrNull(record.started_at);
  if (!startedAt) return null;
  const status = record.status === "running" || record.status === "succeeded" || record.status === "failed" ? record.status : "failed";
  return {
    attempt: record.attempt === null ? null : nonNegativeIntegerOrNull(record.attempt),
    status,
    started_at: startedAt,
    finished_at: stringOrNull(record.finished_at),
    runtime_seconds: finiteNumberOrNull(record.runtime_seconds),
    workspace_path: stringOrNull(record.workspace_path),
    session_id: stringOrNull(record.session_id),
    turn_count: nonNegativeInteger(record.turn_count),
    error: stringOrNull(record.error),
    followup: record.followup === true
  };
}

function normalizeEvent(value: unknown): RuntimeEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const at = stringOrNull(record.at);
  const event = stringOrNull(record.event);
  if (!at || !event) return null;
  return {
    at,
    event,
    ...(typeof record.issue_id === "string" ? { issue_id: record.issue_id } : {}),
    ...(typeof record.issue_identifier === "string" ? { issue_identifier: record.issue_identifier } : {}),
    ...(typeof record.session_id === "string" || record.session_id === null ? { session_id: record.session_id } : {}),
    ...(typeof record.message === "string" || record.message === null ? { message: record.message } : {})
  };
}

function normalizeCodexTotals(value: unknown): DurableStateSnapshot["codex_totals"] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    input_tokens: nonNegativeInteger(record.input_tokens),
    output_tokens: nonNegativeInteger(record.output_tokens),
    total_tokens: nonNegativeInteger(record.total_tokens),
    seconds_running: Math.max(finiteNumberOrNull(record.seconds_running) ?? 0, 0)
  };
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrNow(value: unknown): string {
  return typeof value === "string" ? value : new Date().toISOString();
}

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code);
}

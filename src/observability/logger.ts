import { errorMessage } from "../errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type LogSink = (line: string) => void;

export type Logger = {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
};

const SECRET_KEYS = /token|secret|password|api[_-]?key|authorization/i;

export function createLogger(sink: LogSink = (line) => process.stderr.write(`${line}\n`)): Logger {
  const write = (level: LogLevel, message: string, context: LogContext = {}) => {
    const safeContext = sanitizeContext(context);
    const fields = Object.entries({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...safeContext
    }).map(([key, value]) => `${key}=${formatValue(value)}`);
    try {
      sink(fields.join(" "));
    } catch (error) {
      const fallback = `ts=${new Date().toISOString()} level=warn msg=${formatValue(
        "log sink failed"
      )} error=${formatValue(errorMessage(error))}`;
      process.stderr.write(`${fallback}\n`);
    }
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}

function sanitizeContext(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitizeValue(child);
    }
    return out;
  }
  return value;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return JSON.stringify(text.length > 1200 ? `${text.slice(0, 1200)}...` : text);
}

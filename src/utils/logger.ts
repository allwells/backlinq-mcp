// Structured logger — all output goes to stderr only
// IMPORTANT: Never write to stdout — MCP stdio transport uses stdout for protocol messages

type LogLevel = "info" | "warn" | "error";

interface LogMeta {
  [key: string]: unknown;
}

function formatMessage(
  level: LogLevel,
  message: string,
  meta?: LogMeta,
): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level.toUpperCase()} [Backlinq] ${message}${metaStr}`;
}

export function log(level: LogLevel, message: string, meta?: LogMeta): void {
  process.stderr.write(formatMessage(level, message, meta) + "\n");
}

// Convenience object for callsites that prefer dot notation
export const logger = {
  log,
  info(message: string, meta?: LogMeta): void {
    log("info", message, meta);
  },
  warn(message: string, meta?: LogMeta): void {
    log("warn", message, meta);
  },
  error(message: string, meta?: LogMeta): void {
    log("error", message, meta);
  },
};

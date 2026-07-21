type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold: Level = (process.env.HELIOS_LOG_LEVEL as Level) ?? "info";

function emit(
  level: Level,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) =>
    emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};

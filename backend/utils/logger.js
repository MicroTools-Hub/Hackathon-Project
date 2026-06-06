const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const activeLevel = levels[process.env.LOG_LEVEL || "info"] ?? levels.info;

function log(level, message, meta) {
  if (levels[level] < activeLevel) return;
  const stamp = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console[level === "warn" ? "warn" : level === "error" ? "error" : "log"](`[${stamp}] ${level.toUpperCase()} ${message}${suffix}`);
}

export const logger = {
  debug: (message, meta) => log("debug", message, meta),
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta)
};

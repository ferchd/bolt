export type LogLevel = "debug" | "error" | "info" | "silent" | "warn";
export type LogFormat = "json" | "pretty";
export type LogContext = Readonly<Record<string, unknown>>;
export type LogWriter = (
  line: string,
  level: Exclude<LogLevel, "silent">,
) => void;

export interface LoggerOptions {
  readonly bindings?: LogContext;
  readonly clock?: () => Date;
  readonly format?: LogFormat;
  readonly level?: LogLevel;
  readonly name?: string;
  readonly writer?: LogWriter;
}

export class Logger {
  readonly #bindings: LogContext;
  readonly #clock: () => Date;
  readonly #format: LogFormat;
  readonly #level: LogLevel;
  readonly #name?: string;
  readonly #writer: LogWriter;

  private constructor(options: LoggerOptions) {
    this.#bindings = Object.freeze({ ...options.bindings });
    this.#clock = options.clock ?? (() => new Date());
    this.#format = options.format ?? defaultFormat();
    this.#level = options.level ?? defaultLevel();
    this.#name = options.name;
    this.#writer = options.writer ?? writeToConsole;
  }

  public static create(options: LoggerOptions = {}): Logger {
    return new Logger(options);
  }

  public child(bindings: LogContext): Logger {
    return new Logger({
      bindings: { ...this.#bindings, ...bindings },
      clock: this.#clock,
      format: this.#format,
      level: this.#level,
      name: this.#name,
      writer: this.#writer,
    });
  }

  public debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(
    level: Exclude<LogLevel, "silent">,
    message: string,
    context: LogContext = {},
  ): void {
    if (!shouldWrite(this.#level, level)) {
      return;
    }

    const timestamp = this.#clock().toISOString();
    const metadata = { ...this.#bindings, ...context };
    const line =
      this.#format === "json"
        ? serialize({
            ...metadata,
            level,
            message,
            ...(this.#name ? { name: this.#name } : {}),
            timestamp,
          })
        : formatPretty(timestamp, level, this.#name, message, metadata);

    this.#writer(line, level);
  }
}

function shouldWrite(
  configured: LogLevel,
  requested: Exclude<LogLevel, "silent">,
): boolean {
  return LEVEL_PRIORITY[requested] >= LEVEL_PRIORITY[configured];
}

function defaultFormat(): LogFormat {
  return Bun.env.NODE_ENV === "production" ? "json" : "pretty";
}

function defaultLevel(): LogLevel {
  if (Bun.env.NODE_ENV === "test") {
    return "silent";
  }

  return Bun.env["LOG_LEVEL"] === "debug" ? "debug" : "info";
}

function formatPretty(
  timestamp: string,
  level: Exclude<LogLevel, "silent">,
  name: string | undefined,
  message: string,
  metadata: LogContext,
): string {
  const scope = name ? ` [${name}]` : "";
  const details =
    Object.keys(metadata).length > 0 ? ` ${serialize(metadata)}` : "";

  return `${timestamp} ${level.toUpperCase().padEnd(5)}${scope} ${message}${details}`;
}

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (key, current: unknown) => {
    if (isSensitiveKey(key)) {
      return "[REDACTED]";
    }

    if (current instanceof Error) {
      return {
        message: current.message,
        name: current.name,
        stack: current.stack,
      };
    }

    if (typeof current === "bigint") {
      return current.toString();
    }

    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }

      seen.add(current);
    }

    return current;
  });
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|password|secret|token|api[-_]?key/i.test(key);
}

function writeToConsole(
  line: string,
  level: Exclude<LogLevel, "silent">,
): void {
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

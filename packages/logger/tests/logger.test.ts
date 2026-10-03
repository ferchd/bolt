import { describe, expect, test } from "bun:test";

import { Logger, type LogLevel } from "../src/index.ts";

describe("Logger", () => {
  test("filters records below the configured level", () => {
    const output: string[] = [];
    const logger = createLogger(output, { level: "warn" });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(output).toHaveLength(2);
    expect(output[0]).toContain("warn");
    expect(output[1]).toContain("error");
  });

  test("writes structured JSON with child bindings", () => {
    const output: string[] = [];
    const logger = createLogger(output, { bindings: { service: "api" } });

    logger.child({ requestId: "request-1" }).info("Request completed", {
      status: 200,
    });

    expect(JSON.parse(output[0] ?? "{}")).toEqual({
      level: "info",
      message: "Request completed",
      name: "test",
      requestId: "request-1",
      service: "api",
      status: 200,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  test("redacts secrets and tolerates errors and circular values", () => {
    const output: string[] = [];
    const logger = createLogger(output);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    logger.error("Request failed", {
      circular,
      error: new Error("connection failed"),
      password: "secret-value",
    });

    const record = JSON.parse(output[0] ?? "{}") as Record<string, unknown>;
    expect(record["password"]).toBe("[REDACTED]");
    expect(record["circular"]).toEqual({ self: "[Circular]" });
    expect(record["error"]).toMatchObject({
      message: "connection failed",
      name: "Error",
    });
  });

  test("supports human-readable output", () => {
    const output: string[] = [];
    const logger = Logger.create({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      format: "pretty",
      level: "info",
      name: "test",
      writer: (line) => output.push(line),
    });

    logger.info("Application started", { port: 3000 });

    expect(output[0]).toBe(
      '2026-01-01T00:00:00.000Z INFO  [test] Application started {"port":3000}',
    );
  });
});

function createLogger(
  output: string[],
  options: { bindings?: Record<string, unknown>; level?: LogLevel } = {},
): Logger {
  return Logger.create({
    ...options,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    format: "json",
    level: options.level ?? "debug",
    name: "test",
    writer: (line) => output.push(line),
  });
}

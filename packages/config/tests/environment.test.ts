import { describe, expect, test } from "bun:test";

import { Environment, EnvironmentError } from "../src/index.ts";

describe("Environment", () => {
  test("reads raw values and detects their presence", () => {
    const env = Environment.create({ APP_NAME: "Bolt" });

    expect(env.get("APP_NAME")).toBe("Bolt");
    expect(env.has("APP_NAME")).toBe(true);
    expect(env.has("MISSING")).toBe(false);
  });

  test("uses defaults without hiding missing required values", () => {
    const env = Environment.create({});

    expect(env.string("APP_NAME", "Bolt")).toBe("Bolt");
    expect(() => env.string("APP_KEY")).toThrow(EnvironmentError);
  });

  test("parses finite numbers and safe integers", () => {
    const env = Environment.create({ PORT: "8080", RATIO: "0.5" });

    expect(env.integer("PORT")).toBe(8080);
    expect(env.number("RATIO")).toBe(0.5);
    expect(env.integer("WORKERS", 4)).toBe(4);
  });

  test("rejects malformed numbers without exposing their value", () => {
    const env = Environment.create({ PORT: "not-a-secret-value" });

    expect(() => env.integer("PORT")).toThrow(
      "Invalid environment variable PORT: expected a finite number",
    );
    expect(() => env.integer("PORT")).not.toThrow("not-a-secret-value");
  });

  test("parses common boolean representations", () => {
    const env = Environment.create({ DISABLED: "off", ENABLED: "YES" });

    expect(env.boolean("ENABLED")).toBe(true);
    expect(env.boolean("DISABLED")).toBe(false);
    expect(env.boolean("CACHED", true)).toBe(true);
  });

  test("restricts values while preserving literal types", () => {
    const env = Environment.create({ LOG_LEVEL: "debug" });
    const level = env.oneOf("LOG_LEVEL", ["debug", "info"] as const);

    expect(level).toBe("debug");
    expect(() => env.oneOf("LOG_LEVEL", ["warn", "error"])).toThrow(
      "expected one of: warn, error",
    );
  });

  test("derives the application mode", () => {
    expect(Environment.create({ NODE_ENV: "production" }).isProduction).toBe(
      true,
    );
    expect(Environment.create({ NODE_ENV: "test" }).isTest).toBe(true);
    expect(Environment.create({}).isDevelopment).toBe(true);
  });
});

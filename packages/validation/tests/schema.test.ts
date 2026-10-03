import { describe, expect, test } from "bun:test";

import v, {
  ValidationError,
  type Infer,
  type SafeParseResult,
} from "../src/index.ts";

describe("validation schemas", () => {
  test("parses objects and strips fields outside the schema", () => {
    const userSchema = v.object({
      age: v.number().integer().min(18),
      email: v.string().email(),
      nickname: v.string().min(2).optional(),
    });
    const user: Infer<typeof userSchema> = userSchema.parse({
      age: "21",
      email: "hello@bolt.dev",
      ignored: true,
    });

    expect(user).toEqual({ age: 21, email: "hello@bolt.dev" });
    expect(user.nickname).toBeUndefined();
  });

  test("captures the object shape when the schema is created", () => {
    const shape: Record<string, ReturnType<typeof v.string>> = {
      name: v.string(),
    };
    const schema = v.object(shape);
    shape["injected"] = v.string();

    expect(schema.parse({ name: "Bolt" })).toEqual({ name: "Bolt" });
  });

  test("supports the optional function and method forms", () => {
    expect(v.optional(v.string()).parse(undefined)).toBeUndefined();
    expect(v.string().optional().parse("Bolt")).toBe("Bolt");
    expect(() => v.string().optional().parse(null)).toThrow(ValidationError);
  });

  test("coerces unambiguous HTTP number values", () => {
    const schema = v.number().min(-2).max(100);

    expect(schema.parse(" 42.5 ")).toBe(42.5);
    expect(schema.parse("1e2")).toBe(100);
    expect(() => schema.parse("")).toThrow("Expected a finite number");
    expect(() => schema.parse("0x10")).toThrow("Expected a finite number");
    expect(() => schema.parse("101")).toThrow("less than or equal to 100");
  });

  test("allows number coercion to be disabled", () => {
    const schema = v.number({ coerce: false });

    expect(schema.parse(42)).toBe(42);
    expect(() => schema.parse("42")).toThrow(ValidationError);
  });

  test("coerces common HTTP boolean values", () => {
    const schema = v.boolean();

    expect(schema.parse("true")).toBe(true);
    expect(schema.parse("ON")).toBe(true);
    expect(schema.parse("0")).toBe(false);
    expect(schema.parse(0)).toBe(false);
    expect(() => schema.parse("enabled")).toThrow(ValidationError);
  });

  test("allows boolean coercion to be disabled", () => {
    expect(v.boolean({ coerce: false }).parse(true)).toBe(true);
    expect(() => v.boolean({ coerce: false }).parse("true")).toThrow(
      ValidationError,
    );
  });

  test("validates string length and common formats", () => {
    const schema = v.object({
      code: v.string().min(3).max(5).regex(/^[A-Z]+$/),
      homepage: v.string().url(),
    });

    expect(
      schema.parse({ code: "BOLT", homepage: "https://bolt.dev/docs" }),
    ).toEqual({ code: "BOLT", homepage: "https://bolt.dev/docs" });
    expect(() => schema.parse({ code: "bo", homepage: "/docs" })).toThrow(
      ValidationError,
    );
  });

  test("validates arrays and coerces their individual items", () => {
    const schema = v.array(v.number().integer()).min(2).max(3);

    expect(schema.parse(["1", 2])).toEqual([1, 2]);
    expect(() => schema.parse([1])).toThrow("at least 2 items");
    expect(() => schema.parse([1, 2, 3, 4])).toThrow("at most 3 items");
  });

  test("safeParse returns a discriminated result without throwing", () => {
    const result: SafeParseResult<number> = v.number().safeParse("invalid");

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  test("collects nested issues with deterministic paths", () => {
    const schema = v.object({
      profile: v.object({
        email: v.string().email(),
        scores: v.array(v.number().min(0)),
      }),
    });
    const result = schema.safeParse({
      profile: { email: "invalid", scores: ["bad", -1] },
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toEqual([
        {
          code: "invalid_format",
          message: "Must be a valid email address",
          path: ["profile", "email"],
        },
        {
          code: "invalid_type",
          message: "Expected a finite number",
          path: ["profile", "scores", 0],
        },
        {
          code: "too_small",
          message: "Must be greater than or equal to 0",
          path: ["profile", "scores", 1],
        },
      ]);
      expect(result.error.message).toContain("$.profile.email");
    }
  });

  test("rejects invalid rule declarations immediately", () => {
    expect(() => v.string().min(-1)).toThrow(RangeError);
    expect(() => v.array(v.string()).max(1.5)).toThrow(RangeError);
    expect(() => v.number().min(Number.NaN)).toThrow(RangeError);
  });

  test("does not leak mutable issue paths", () => {
    const result = v.object({ name: v.string() }).safeParse({ name: 1 });

    if (!result.success) {
      expect(Object.isFrozen(result.error.issues)).toBe(true);
      expect(Object.isFrozen(result.error.issues[0]?.path)).toBe(true);
    }
  });
});

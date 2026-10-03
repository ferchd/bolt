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

  test("validates literals, enums, and unions with strict inference", () => {
    const statusSchema = v.enum(["draft", "published"] as const);
    const identifierSchema = v.union([v.number().integer(), v.uuid()]);
    const status: Infer<typeof statusSchema> = statusSchema.parse("draft");
    const identifier: Infer<typeof identifierSchema> = identifierSchema.parse(
      "01941f5c-7a38-7c51-b41c-2e6c2ad1f15e",
    );

    expect(status).toBe("draft");
    expect(identifier).toBe("01941f5c-7a38-7c51-b41c-2e6c2ad1f15e");
    expect(v.literal(true).parse(true)).toBe(true);
    expect(() => statusSchema.parse("archived")).toThrow(
      'Expected one of: "draft", "published"',
    );

    const nested = v.object({ identifier: identifierSchema }).safeParse({
      identifier: false,
    });

    expect(nested.success).toBe(false);
    if (!nested.success) {
      expect(nested.error.issues).toEqual([
        {
          code: "invalid_union",
          message: "Input does not match any union member",
          path: ["identifier"],
        },
      ]);
    }
  });

  test("captures enum and union members when schemas are created", () => {
    const values: [string, string] = ["one", "two"];
    const members: [ReturnType<typeof v.string>, ReturnType<typeof v.number>] = [
      v.string(),
      v.number(),
    ];
    const enumSchema = v.enum(values);
    const unionSchema = v.union(members);

    values[0] = "changed";
    members[0] = v.string().email();

    expect(enumSchema.parse("one")).toBe("one");
    expect(unionSchema.parse("not-an-email")).toBe("not-an-email");
  });

  test("supports nullable values and defaults without weakening object types", () => {
    const schema = v.object({
      enabled: v.boolean().default(true),
      label: v.string().nullable(),
      nonce: v.number().default(() => 42),
    });
    const value: Infer<typeof schema> = schema.parse({ label: null });

    expect(value).toEqual({ enabled: true, label: null, nonce: 42 });
    expect(v.nullable(v.number()).parse("12")).toBe(12);
    expect(() => schema.parse({ enabled: null, label: "Bolt" })).toThrow(
      ValidationError,
    );
  });

  test("refines and transforms only successfully parsed values", () => {
    type Slug = string & { readonly __brand: "Slug" };
    const slugSchema = v
      .string()
      .refine((value): value is Slug => /^[a-z]+(?:-[a-z]+)*$/.test(value), "Invalid slug")
      .transform((value) => ({ slug: value }));
    const output: Infer<typeof slugSchema> = slugSchema.parse("bolt-framework");

    expect(String(output.slug)).toBe("bolt-framework");
    expect(() => slugSchema.parse("Bolt Framework")).toThrow("Invalid slug");
    expect(() => slugSchema.parse(10)).toThrow("Expected a string");
  });

  test("creates top-level partial object schemas without changing the original", () => {
    const createSchema = v.object({
      active: v.boolean(),
      name: v.string().min(1),
    });
    const updateSchema = createSchema.partial();
    const update: Infer<typeof updateSchema> = updateSchema.parse({ active: "yes" });

    expect(update).toEqual({ active: true });
    expect(updateSchema.parse({})).toEqual({});
    expect(() => createSchema.parse({})).toThrow(ValidationError);
    expect(() => updateSchema.parse({ name: "" })).toThrow(
      "at least 1 characters",
    );
  });

  test("parses valid dates conservatively and returns defensive copies", () => {
    const original = new Date("2025-01-10T00:00:00.000Z");
    const schema = v
      .date()
      .min(new Date("2025-01-01T00:00:00.000Z"))
      .max(new Date("2025-12-31T23:59:59.999Z"));
    const parsed = schema.parse(original);

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(v.date().parse("2024-02-29").toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(v.date().parse("2025-01-10T14:30:00-05:00").toISOString()).toBe(
      "2025-01-10T19:30:00.000Z",
    );
    expect(() => v.date().parse("2023-02-29")).toThrow("valid date");
    expect(() => v.date().parse("2025-02-29T10:00:00Z")).toThrow(
      "valid date",
    );
    expect(() => v.date().parse("2025-01-10T25:00:00Z")).toThrow(
      "valid date",
    );
    expect(() => v.date().parse("01/10/2025")).toThrow("valid date");
    expect(() => v.date({ coerce: false }).parse("2025-01-10")).toThrow(
      ValidationError,
    );
  });

  test("validates File, Blob, and BunFile inputs without HTTP coupling", () => {
    const imageSchema = v.file().min(2).max(10).mime("image/*");
    const upload = new File(["bolt"], "bolt.png", { type: "image/png" });
    const form = new FormData();
    form.set("title", "Logo");
    form.set("upload", upload);
    const formSchema = v.object({ title: v.string(), upload: imageSchema });

    expect(imageSchema.parse(upload)).toBe(upload);
    expect(formSchema.parse(Object.fromEntries(form))).toEqual({
      title: "Logo",
      upload,
    });
    expect(v.file().parse(new Blob(["text"], { type: "text/plain" }))).toBeInstanceOf(Blob);
    expect(v.file().parse(Bun.file("package.json"))).toBeInstanceOf(Blob);
    expect(() => imageSchema.parse(new Blob(["x"], { type: "text/plain" }))).toThrow(
      ValidationError,
    );
    expect(() => v.file().mime([])).toThrow(TypeError);
  });

  test("validates UUID versions supported by the UUID standard", () => {
    expect(v.uuid().parse("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(v.string().uuid().parse("01941f5c-7a38-7c51-b41c-2e6c2ad1f15e")).toBe(
      "01941f5c-7a38-7c51-b41c-2e6c2ad1f15e",
    );
    expect(() => v.uuid().parse("not-a-uuid")).toThrow("valid UUID");
  });
});

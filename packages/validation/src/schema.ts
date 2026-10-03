import {
  ValidationError,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationPath,
} from "./validation-error.ts";

export type SafeParseResult<Output> =
  | { readonly data: Output; readonly success: true }
  | { readonly error: ValidationError; readonly success: false };

export type Infer<Definition extends Schema<unknown>> =
  Definition extends Schema<infer Output> ? Output : never;

interface ParseSuccess<Output> {
  readonly success: true;
  readonly value: Output;
}

interface ParseFailure {
  readonly success: false;
}

type ParseResult<Output> = ParseFailure | ParseSuccess<Output>;

interface ParseContext {
  readonly issues: ValidationIssue[];
  readonly path: ValidationPath;
}

export abstract class Schema<Output> {
  public parse(input: unknown): Output {
    const result = this.safeParse(input);

    if (!result.success) {
      throw result.error;
    }

    return result.data;
  }

  public safeParse(input: unknown): SafeParseResult<Output> {
    const issues: ValidationIssue[] = [];
    const result = this._parse(input, { issues, path: [] });

    if (!result.success) {
      return { error: new ValidationError(issues), success: false };
    }

    return { data: result.value, success: true };
  }

  public optional(): OptionalSchema<this> {
    return new OptionalSchema(this);
  }

  /** @internal Used by composable schemas. */
  public abstract _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Output>;
}

export interface CoercionOptions {
  readonly coerce?: boolean;
}

interface StringRule {
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly test: (value: string) => boolean;
}

export class StringSchema extends Schema<string> {
  readonly #rules: readonly StringRule[];

  public constructor(rules: readonly StringRule[] = []) {
    super();
    this.#rules = rules;
  }

  public min(length: number, message = `Must contain at least ${length} characters`): StringSchema {
    assertNonNegativeInteger(length, "String minimum length");
    return this.withRule({
      code: "too_small",
      message,
      test: (value) => value.length >= length,
    });
  }

  public max(length: number, message = `Must contain at most ${length} characters`): StringSchema {
    assertNonNegativeInteger(length, "String maximum length");
    return this.withRule({
      code: "too_big",
      message,
      test: (value) => value.length <= length,
    });
  }

  public email(message = "Must be a valid email address"): StringSchema {
    return this.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, message);
  }

  public url(message = "Must be a valid absolute URL"): StringSchema {
    return this.withRule({
      code: "invalid_format",
      message,
      test: (value) => URL.canParse(value),
    });
  }

  public regex(pattern: RegExp, message = "Has an invalid format"): StringSchema {
    const stablePattern = new RegExp(pattern.source, pattern.flags);

    return this.withRule({
      code: "invalid_format",
      message,
      test: (value) => {
        stablePattern.lastIndex = 0;
        const matches = stablePattern.test(value);
        stablePattern.lastIndex = 0;
        return matches;
      },
    });
  }

  public override _parse(input: unknown, context: ParseContext): ParseResult<string> {
    if (typeof input !== "string") {
      addIssue(context, "invalid_type", "Expected a string");
      return failure;
    }

    let valid = true;

    for (const rule of this.#rules) {
      if (!rule.test(input)) {
        addIssue(context, rule.code, rule.message);
        valid = false;
      }
    }

    return valid ? success(input) : failure;
  }

  private withRule(rule: StringRule): StringSchema {
    return new StringSchema([...this.#rules, rule]);
  }
}

interface NumberRule {
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly test: (value: number) => boolean;
}

export class NumberSchema extends Schema<number> {
  readonly #coerce: boolean;
  readonly #rules: readonly NumberRule[];

  public constructor(options: CoercionOptions = {}, rules: readonly NumberRule[] = []) {
    super();
    this.#coerce = options.coerce ?? true;
    this.#rules = rules;
  }

  public integer(message = "Must be an integer"): NumberSchema {
    return this.withRule({
      code: "invalid_value",
      message,
      test: Number.isSafeInteger,
    });
  }

  public min(minimum: number, message = `Must be greater than or equal to ${minimum}`): NumberSchema {
    assertFinite(minimum, "Number minimum");
    return this.withRule({
      code: "too_small",
      message,
      test: (value) => value >= minimum,
    });
  }

  public max(maximum: number, message = `Must be less than or equal to ${maximum}`): NumberSchema {
    assertFinite(maximum, "Number maximum");
    return this.withRule({
      code: "too_big",
      message,
      test: (value) => value <= maximum,
    });
  }

  public override _parse(input: unknown, context: ParseContext): ParseResult<number> {
    const value = this.#coerce ? coerceNumber(input) : input;

    if (typeof value !== "number" || !Number.isFinite(value)) {
      addIssue(context, "invalid_type", "Expected a finite number");
      return failure;
    }

    let valid = true;

    for (const rule of this.#rules) {
      if (!rule.test(value)) {
        addIssue(context, rule.code, rule.message);
        valid = false;
      }
    }

    return valid ? success(value) : failure;
  }

  private withRule(rule: NumberRule): NumberSchema {
    return new NumberSchema({ coerce: this.#coerce }, [...this.#rules, rule]);
  }
}

export class BooleanSchema extends Schema<boolean> {
  readonly #coerce: boolean;

  public constructor(options: CoercionOptions = {}) {
    super();
    this.#coerce = options.coerce ?? true;
  }

  public override _parse(input: unknown, context: ParseContext): ParseResult<boolean> {
    const value = this.#coerce ? coerceBoolean(input) : input;

    if (typeof value !== "boolean") {
      addIssue(context, "invalid_type", "Expected a boolean");
      return failure;
    }

    return success(value);
  }
}

export class ArraySchema<ItemSchema extends Schema<unknown>> extends Schema<
  Infer<ItemSchema>[]
> {
  readonly #item: ItemSchema;
  readonly #maximum?: number;
  readonly #minimum?: number;

  public constructor(
    item: ItemSchema,
    limits: { readonly maximum?: number; readonly minimum?: number } = {},
  ) {
    super();
    this.#item = item;
    this.#maximum = limits.maximum;
    this.#minimum = limits.minimum;
  }

  public min(length: number): ArraySchema<ItemSchema> {
    assertNonNegativeInteger(length, "Array minimum length");
    return new ArraySchema(this.#item, {
      maximum: this.#maximum,
      minimum: length,
    });
  }

  public max(length: number): ArraySchema<ItemSchema> {
    assertNonNegativeInteger(length, "Array maximum length");
    return new ArraySchema(this.#item, {
      maximum: length,
      minimum: this.#minimum,
    });
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Infer<ItemSchema>[]> {
    if (!Array.isArray(input)) {
      addIssue(context, "invalid_type", "Expected an array");
      return failure;
    }

    let valid = true;

    if (this.#minimum !== undefined && input.length < this.#minimum) {
      addIssue(
        context,
        "too_small",
        `Must contain at least ${this.#minimum} items`,
      );
      valid = false;
    }

    if (this.#maximum !== undefined && input.length > this.#maximum) {
      addIssue(
        context,
        "too_big",
        `Must contain at most ${this.#maximum} items`,
      );
      valid = false;
    }

    const output: Infer<ItemSchema>[] = [];

    for (const [index, value] of input.entries()) {
      const result = this.#item._parse(value, childContext(context, index));

      if (result.success) {
        output.push(result.value as Infer<ItemSchema>);
      } else {
        valid = false;
      }
    }

    return valid ? success(output) : failure;
  }
}

export type ObjectShape = Readonly<Record<string, Schema<unknown>>>;

type OptionalKey<Shape extends ObjectShape> = {
  [Key in keyof Shape]: undefined extends Infer<Shape[Key]> ? Key : never;
}[keyof Shape];

type RequiredKey<Shape extends ObjectShape> = Exclude<keyof Shape, OptionalKey<Shape>>;

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

export type ObjectOutput<Shape extends ObjectShape> = Simplify<
  { [Key in RequiredKey<Shape>]: Infer<Shape[Key]> } & {
    [Key in OptionalKey<Shape>]?: Exclude<Infer<Shape[Key]>, undefined>;
  }
>;

export class ObjectSchema<Shape extends ObjectShape> extends Schema<
  ObjectOutput<Shape>
> {
  readonly #shape: Shape;

  public constructor(shape: Shape) {
    super();
    this.#shape = Object.freeze({ ...shape }) as Shape;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<ObjectOutput<Shape>> {
    if (!isObject(input)) {
      addIssue(context, "invalid_type", "Expected an object");
      return failure;
    }

    let valid = true;
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(this.#shape)) {
      const definition = this.#shape[key];

      if (!definition) {
        continue;
      }

      const result = definition._parse(input[key], childContext(context, key));

      if (!result.success) {
        valid = false;
        continue;
      }

      if (result.value !== undefined) {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: result.value,
          writable: true,
        });
      }
    }

    return valid ? success(output as ObjectOutput<Shape>) : failure;
  }
}

export class OptionalSchema<Inner extends Schema<unknown>> extends Schema<
  Infer<Inner> | undefined
> {
  readonly #inner: Inner;

  public constructor(inner: Inner) {
    super();
    this.#inner = inner;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Infer<Inner> | undefined> {
    return input === undefined
      ? success(undefined)
      : (this.#inner._parse(input, context) as ParseResult<Infer<Inner>>);
  }
}

export function string(): StringSchema {
  return new StringSchema();
}

export function number(options?: CoercionOptions): NumberSchema {
  return new NumberSchema(options);
}

export function boolean(options?: CoercionOptions): BooleanSchema {
  return new BooleanSchema(options);
}

export function array<ItemSchema extends Schema<unknown>>(
  item: ItemSchema,
): ArraySchema<ItemSchema> {
  return new ArraySchema(item);
}

export function object<const Shape extends ObjectShape>(
  shape: Shape,
): ObjectSchema<Shape> {
  return new ObjectSchema(shape);
}

export function optional<Inner extends Schema<unknown>>(
  inner: Inner,
): OptionalSchema<Inner> {
  return new OptionalSchema(inner);
}

function success<Output>(value: Output): ParseSuccess<Output> {
  return { success: true, value };
}

const failure: ParseFailure = Object.freeze({ success: false });

function addIssue(
  context: ParseContext,
  code: ValidationIssueCode,
  message: string,
): void {
  context.issues.push({ code, message, path: context.path });
}

function childContext(
  context: ParseContext,
  segment: number | string,
): ParseContext {
  return { issues: context.issues, path: [...context.path, segment] };
}

function coerceNumber(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  const value = input.trim();

  if (
    value.length === 0 ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
  ) {
    return input;
  }

  return Number(value);
}

function coerceBoolean(input: unknown): unknown {
  if (typeof input === "number") {
    return input === 1 ? true : input === 0 ? false : input;
  }

  if (typeof input !== "string") {
    return input;
  }

  const value = input.trim().toLowerCase();

  if (["1", "on", "true", "yes"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return input;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

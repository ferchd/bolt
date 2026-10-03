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

  public nullable(): NullableSchema<Schema<Output>> {
    return new NullableSchema(this);
  }

  public default(
    value:
      | Exclude<Output, undefined>
      | (() => Exclude<Output, undefined>),
  ): DefaultSchema<Schema<Output>> {
    return new DefaultSchema<Schema<Output>>(this, value);
  }

  public refine<Refined extends Output>(
    predicate: (value: Output) => value is Refined,
    message?: string,
  ): RefinementSchema<Schema<Output>, Refined>;
  public refine(
    predicate: (value: Output) => boolean,
    message?: string,
  ): RefinementSchema<Schema<Output>, Output>;
  public refine(
    predicate: (value: Output) => boolean,
    message = "Failed custom validation",
  ): RefinementSchema<Schema<Output>, Output> {
    return new RefinementSchema(this, predicate, message);
  }

  public transform<Transformed>(
    transformer: (value: Output) => Transformed,
  ): TransformSchema<Schema<Output>, Transformed> {
    return new TransformSchema(this, transformer);
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

  public uuid(message = "Must be a valid UUID"): StringSchema {
    return this.regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      message,
    );
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

export type LiteralValue = bigint | boolean | null | number | string;

export class LiteralSchema<Value extends LiteralValue> extends Schema<Value> {
  readonly #value: Value;

  public constructor(value: Value) {
    super();
    this.#value = value;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Value> {
    if (!Object.is(input, this.#value)) {
      addIssue(context, "invalid_value", `Expected ${formatLiteral(this.#value)}`);
      return failure;
    }

    return success(this.#value);
  }
}

export class EnumSchema<Values extends readonly [LiteralValue, ...LiteralValue[]]>
  extends Schema<Values[number]>
{
  readonly #values: ReadonlySet<LiteralValue>;
  readonly #description: string;

  public constructor(values: Values) {
    super();
    const snapshot = Object.freeze([...values]) as unknown as Values;
    this.#values = new Set(snapshot);
    this.#description = snapshot.map(formatLiteral).join(", ");
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Values[number]> {
    if (!this.#values.has(input as LiteralValue)) {
      addIssue(context, "invalid_value", `Expected one of: ${this.#description}`);
      return failure;
    }

    return success(input as Values[number]);
  }
}

export class UnionSchema<
  Members extends readonly [Schema<unknown>, Schema<unknown>, ...Schema<unknown>[]],
> extends Schema<Infer<Members[number]>> {
  readonly #members: Members;

  public constructor(members: Members) {
    super();
    this.#members = Object.freeze([...members]) as unknown as Members;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Infer<Members[number]>> {
    for (const member of this.#members) {
      const branchIssues: ValidationIssue[] = [];
      const result = member._parse(input, {
        issues: branchIssues,
        path: context.path,
      });

      if (result.success) {
        return result as ParseSuccess<Infer<Members[number]>>;
      }
    }

    addIssue(context, "invalid_union", "Input does not match any union member");
    return failure;
  }
}

export type DateOptions = CoercionOptions;

interface DateLimits {
  readonly maximum?: number;
  readonly maximumMessage?: string;
  readonly minimum?: number;
  readonly minimumMessage?: string;
}

export class DateSchema extends Schema<Date> {
  readonly #coerce: boolean;
  readonly #maximum?: number;
  readonly #maximumMessage?: string;
  readonly #minimum?: number;
  readonly #minimumMessage?: string;

  public constructor(
    options: DateOptions = {},
    limits: DateLimits = {},
  ) {
    super();
    this.#coerce = options.coerce ?? true;
    this.#maximum = limits.maximum;
    this.#maximumMessage = limits.maximumMessage;
    this.#minimum = limits.minimum;
    this.#minimumMessage = limits.minimumMessage;
  }

  public min(minimum: Date, message?: string): DateSchema {
    const timestamp = assertValidDate(minimum, "Date minimum");
    return new DateSchema(
      { coerce: this.#coerce },
      {
        maximum: this.#maximum,
        maximumMessage: this.#maximumMessage,
        minimum: timestamp,
        minimumMessage: message ?? `Must be on or after ${minimum.toISOString()}`,
      },
    );
  }

  public max(maximum: Date, message?: string): DateSchema {
    const timestamp = assertValidDate(maximum, "Date maximum");
    return new DateSchema(
      { coerce: this.#coerce },
      {
        maximum: timestamp,
        maximumMessage: message ?? `Must be on or before ${maximum.toISOString()}`,
        minimum: this.#minimum,
        minimumMessage: this.#minimumMessage,
      },
    );
  }

  public override _parse(input: unknown, context: ParseContext): ParseResult<Date> {
    const value = parseDate(input, this.#coerce);

    if (!value) {
      addIssue(context, "invalid_type", "Expected a valid date");
      return failure;
    }

    if (this.#minimum !== undefined && value.getTime() < this.#minimum) {
      addIssue(context, "too_small", this.#minimumMessage ?? "Date is too early");
      return failure;
    }

    if (this.#maximum !== undefined && value.getTime() > this.#maximum) {
      addIssue(context, "too_big", this.#maximumMessage ?? "Date is too late");
      return failure;
    }

    return success(value);
  }
}

interface FileRule {
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly test: (value: Blob) => boolean;
}

export class FileSchema extends Schema<Blob> {
  readonly #rules: readonly FileRule[];

  public constructor(rules: readonly FileRule[] = []) {
    super();
    this.#rules = rules;
  }

  public min(size: number, message = `File must contain at least ${size} bytes`): FileSchema {
    assertNonNegativeInteger(size, "File minimum size");
    return this.withRule({
      code: "too_small",
      message,
      test: (value) => value.size >= size,
    });
  }

  public max(size: number, message = `File must contain at most ${size} bytes`): FileSchema {
    assertNonNegativeInteger(size, "File maximum size");
    return this.withRule({
      code: "too_big",
      message,
      test: (value) => value.size <= size,
    });
  }

  public mime(
    types: string | readonly string[],
    message = "File has an unsupported media type",
  ): FileSchema {
    const allowed = typeof types === "string" ? [types] : [...types];

    if (allowed.length === 0 || allowed.some((type) => type.trim().length === 0)) {
      throw new TypeError("File MIME types must contain at least one non-empty value");
    }

    return this.withRule({
      code: "invalid_format",
      message,
      test: (value) => allowed.some((type) => matchesMime(value.type, type)),
    });
  }

  public override _parse(input: unknown, context: ParseContext): ParseResult<Blob> {
    if (!(input instanceof Blob)) {
      addIssue(context, "invalid_type", "Expected a file");
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

  private withRule(rule: FileRule): FileSchema {
    return new FileSchema([...this.#rules, rule]);
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

export type PartialObjectShape<Shape extends ObjectShape> = {
  readonly [Key in keyof Shape]: OptionalSchema<Shape[Key]>;
};

export class ObjectSchema<Shape extends ObjectShape> extends Schema<
  ObjectOutput<Shape>
> {
  readonly #shape: Shape;

  public constructor(shape: Shape) {
    super();
    this.#shape = Object.freeze({ ...shape }) as Shape;
  }

  public partial(): ObjectSchema<PartialObjectShape<Shape>> {
    const partialShape: Record<string, OptionalSchema<Schema<unknown>>> = {};

    for (const key of Object.keys(this.#shape)) {
      const definition = this.#shape[key];

      if (definition) {
        partialShape[key] = new OptionalSchema(definition);
      }
    }

    return new ObjectSchema(
      partialShape as PartialObjectShape<Shape>,
    );
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

export class NullableSchema<Inner extends Schema<unknown>> extends Schema<
  Infer<Inner> | null
> {
  readonly #inner: Inner;

  public constructor(inner: Inner) {
    super();
    this.#inner = inner;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Infer<Inner> | null> {
    return input === null
      ? success(null)
      : (this.#inner._parse(input, context) as ParseResult<Infer<Inner>>);
  }
}

export class DefaultSchema<Inner extends Schema<unknown>> extends Schema<
  Exclude<Infer<Inner>, undefined>
> {
  readonly #defaultValue:
    | Exclude<Infer<Inner>, undefined>
    | (() => Exclude<Infer<Inner>, undefined>);
  readonly #inner: Inner;

  public constructor(
    inner: Inner,
    defaultValue:
      | Exclude<Infer<Inner>, undefined>
      | (() => Exclude<Infer<Inner>, undefined>),
  ) {
    super();
    this.#inner = inner;
    this.#defaultValue = defaultValue;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Exclude<Infer<Inner>, undefined>> {
    const value = input === undefined
      ? typeof this.#defaultValue === "function"
        ? (this.#defaultValue as () => Exclude<Infer<Inner>, undefined>)()
        : this.#defaultValue
      : input;

    return this.#inner._parse(value, context) as ParseResult<
      Exclude<Infer<Inner>, undefined>
    >;
  }
}

export class RefinementSchema<
  Inner extends Schema<unknown>,
  Refined extends Infer<Inner>,
> extends Schema<Refined> {
  readonly #inner: Inner;
  readonly #message: string;
  readonly #predicate: (value: Infer<Inner>) => boolean;

  public constructor(
    inner: Inner,
    predicate: (value: Infer<Inner>) => boolean,
    message: string,
  ) {
    super();
    this.#inner = inner;
    this.#predicate = predicate;
    this.#message = message;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Refined> {
    const result = this.#inner._parse(input, context);

    if (!result.success) {
      return failure;
    }

    if (!this.#predicate(result.value as Infer<Inner>)) {
      addIssue(context, "invalid_value", this.#message);
      return failure;
    }

    return success(result.value as Refined);
  }
}

export class TransformSchema<
  Inner extends Schema<unknown>,
  Transformed,
> extends Schema<Transformed> {
  readonly #inner: Inner;
  readonly #transformer: (value: Infer<Inner>) => Transformed;

  public constructor(
    inner: Inner,
    transformer: (value: Infer<Inner>) => Transformed,
  ) {
    super();
    this.#inner = inner;
    this.#transformer = transformer;
  }

  public override _parse(
    input: unknown,
    context: ParseContext,
  ): ParseResult<Transformed> {
    const result = this.#inner._parse(input, context);

    return result.success
      ? success(this.#transformer(result.value as Infer<Inner>))
      : failure;
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

export function literal<const Value extends LiteralValue>(
  value: Value,
): LiteralSchema<Value> {
  return new LiteralSchema(value);
}

export function enumeration<
  const Values extends readonly [LiteralValue, ...LiteralValue[]],
>(values: Values): EnumSchema<Values> {
  return new EnumSchema(values);
}

export function union<
  const Members extends readonly [
    Schema<unknown>,
    Schema<unknown>,
    ...Schema<unknown>[],
  ],
>(members: Members): UnionSchema<Members> {
  return new UnionSchema(members);
}

export function date(options?: DateOptions): DateSchema {
  return new DateSchema(options);
}

export function uuid(): StringSchema {
  return new StringSchema().uuid();
}

export function file(): FileSchema {
  return new FileSchema();
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

export function nullable<Inner extends Schema<unknown>>(
  inner: Inner,
): NullableSchema<Inner> {
  return new NullableSchema(inner);
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

function parseDate(input: unknown, coerce: boolean): Date | undefined {
  if (input instanceof Date) {
    return Number.isFinite(input.getTime())
      ? new Date(input.getTime())
      : undefined;
  }

  if (!coerce || typeof input !== "string") {
    return undefined;
  }

  const value = input.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);

    return isValidCalendarDate(year, month, day)
      ? new Date(`${value}T00:00:00.000Z`)
      : undefined;
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
    value,
  );

  if (!dateTime) {
    return undefined;
  }

  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]);
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  const offsetHour = dateTime[7] === undefined ? 0 : Number(dateTime[7]);
  const offsetMinute = dateTime[8] === undefined ? 0 : Number(dateTime[8]);

  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return day <= (days[month - 1] ?? 0);
}

function matchesMime(actual: string, expected: string): boolean {
  const normalizedActual = actual.toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();

  return normalizedExpected.endsWith("/*")
    ? normalizedActual.startsWith(normalizedExpected.slice(0, -1))
    : normalizedActual === normalizedExpected;
}

function formatLiteral(value: LiteralValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return typeof value === "bigint" ? `${value}n` : String(value);
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

function assertValidDate(value: Date, label: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} must be a valid date`);
  }

  return value.getTime();
}

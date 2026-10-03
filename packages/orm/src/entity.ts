import type { SqlOutputParameter, SqlValue } from "@bolt/database";
import { Expr, quoteIdentifier, quoteTable } from "./expressions.ts";

export interface Column<T> {
  readonly name?: string;
  readonly primaryKey?: boolean;
  readonly generated?: boolean;
  /** Oracle RETURNING output representation. Defaults to exact decimal/string output. */
  readonly generatedOutput?: SqlOutputParameter;
  readonly version?: boolean;
  readonly encode?: (value: T) => SqlValue;
  readonly decode?: (value: unknown) => T;
}
export type Columns<T extends object> = { readonly [K in keyof T]-?: Column<T[K]> };
export type Fields<T extends object> = { readonly [K in keyof T]-?: Expr<T[K]> };
export interface EntityOptions<T extends object> { readonly table: string; readonly columns: Columns<T>; }
export interface Entity<T extends object> {
  readonly table: string;
  readonly columns: Columns<T>;
  readonly keys: readonly (keyof T & string)[];
  readonly generated?: keyof T & string;
  readonly generatedKeys: readonly (keyof T & string)[];
  readonly version?: keyof T & string;
}
export function defineEntity<T extends object>(options: EntityOptions<T>): Entity<T> {
  quoteTable(options.table, "sqlite");
  const keys: (keyof T & string)[] = [];
  let generated: keyof T & string | undefined;
  const generatedKeys: (keyof T & string)[] = [];
  let version: keyof T & string | undefined;
  const columns: Record<string, Column<unknown>> = {};
  const names = new Set<string>();
  for (const [property, column] of Object.entries(options.columns) as [keyof T & string, Column<unknown>][]) {
    quoteIdentifier(property, "sqlite");
    const name = column.name ?? property;
    quoteIdentifier(name, "sqlite");
    if (names.has(name)) throw new Error(`Duplicate column: ${name}`);
    names.add(name);
    if (column.generatedOutput && !column.generated) throw new Error("Output binding metadata requires a generated column");
    columns[property] = Object.freeze({ ...column, name, ...(column.version ? { encode: column.encode ?? codecs.integer.encode as (value: unknown) => SqlValue, decode: column.decode ?? codecs.integer.decode } : {}), ...(column.generatedOutput ? { generatedOutput: Object.freeze({ ...column.generatedOutput }) } : {}) });
    if (column.primaryKey) keys.push(property);
    if (column.generated) {
      if (!column.primaryKey) throw new Error("Generated columns must be primary keys");
      generated ??= property;
      generatedKeys.push(property);
    }
    if (column.version) {
      if (version || column.primaryKey || column.generated) throw new Error("A single non-key numeric version column is supported per entity");
      version = property;
    }
  }
  if (!keys.length) throw new Error("An entity must declare a primary key (composite keys are supported)");
  return Object.freeze({ table: options.table, columns: Object.freeze(columns) as Columns<T>, keys: Object.freeze(keys), generatedKeys: Object.freeze(generatedKeys), ...(generated ? { generated } : {}), ...(version ? { version } : {}) });
}
export function fields<T extends object>(entity: Entity<T>, alias: string): Fields<T> {
  return Object.freeze(Object.fromEntries(entries(entity).map(([key, column]) => [key, new Expr({ kind: "column", alias, name: column.name ?? key }, column)]))) as Fields<T>;
}
export function entries<T extends object>(entity: Entity<T>): [keyof T & string, Column<unknown>][] { return Object.entries(entity.columns) as [keyof T & string, Column<unknown>][]; }
export function encode<T extends object>(entity: Entity<T>, key: keyof T & string, value: unknown): SqlValue {
  const column = entity.columns[key] as Column<unknown>;
  if (column.encode) return column.encode(value);
  if (value === null || typeof value === "string" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Date || value instanceof Uint8Array || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new TypeError(`Column ${key} requires a SQL value or an explicit codec`);
}
export function decode<T extends object>(entity: Entity<T>, row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, column] of entries(entity)) result[key] = column.decode ? column.decode(row[key]) : row[key];
  return result as T;
}
export function entityKey<T extends object>(entity: Entity<T>, instance: Partial<T>): string {
  return JSON.stringify(entity.keys.map(key => {
    const val = instance[key];
    if (val === undefined || val === null) throw new Error(`Primary key ${key} must be assigned`);
    return keyValue(encode(entity, key, val));
  }));
}
export function keyValue(input: SqlValue): unknown {
  if (input instanceof Date) return ["date", input.toISOString()];
  if (input instanceof Uint8Array) return ["bytes", Array.from(input)];
  return [typeof input, typeof input === "bigint" ? input.toString() : input];
}
export const codecs = {
  integer: {
    encode: (input: number): SqlValue => { if (!Number.isSafeInteger(input)) throw new TypeError("Integer codec requires a safe integer"); return input; },
    decode: (input: unknown): number => {
      if ((typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") || !/^-?\d+$/.test(String(input))) throw new TypeError("Invalid persisted integer");
      const result = Number(input); if (!Number.isSafeInteger(result)) throw new RangeError("Persisted integer exceeds JavaScript safe integer range"); return result;
    },
  },
  bigint: {
    encode: (input: bigint): SqlValue => { if (typeof input !== "bigint") throw new TypeError("Bigint codec requires bigint"); return input.toString(); },
    decode: (input: unknown): bigint => {
      if ((typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") || !/^-?\d+$/.test(String(input)) || (typeof input === "number" && !Number.isSafeInteger(input))) throw new TypeError("Invalid persisted bigint");
      return BigInt(input);
    },
  },
  decimal: {
    encode: (input: string): SqlValue => decimalText(input),
    decode: (input: unknown): string => decimalText(input),
  },
  nullable<T>(codec: Required<Pick<Column<T>, "encode" | "decode">>): Required<Pick<Column<T | null>, "encode" | "decode">> {
    return { encode: input => input === null ? null : codec.encode(input), decode: input => input === null ? null : codec.decode(input) };
  },
  date: { encode: (input: Date): SqlValue => input.toISOString(), decode: (input: unknown): Date => {
    const text = String(input);
    // SQL timestamps without an offset represent the UTC value emitted by this codec, regardless of host timezone.
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
    const date = input instanceof Date ? new Date(input.getTime()) : new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid persisted date");
    return date;
  } },
  boolean: { encode: (input: boolean): SqlValue => { if (typeof input !== "boolean") throw new TypeError("Boolean codec requires boolean"); return input ? 1 : 0; }, decode: (input: unknown): boolean => {
    if (input === true || input === 1 || input === 1n || input === "1") return true;
    if (input === false || input === 0 || input === 0n || input === "0") return false;
    throw new TypeError("Invalid persisted boolean");
  } },
  json<T>(): Required<Pick<Column<T>, "encode" | "decode">> { return { encode: (input: T): SqlValue => JSON.stringify(input), decode: (input: unknown): T => JSON.parse(String(input)) as T }; },
};
function decimalText(input: unknown): string {
  if (typeof input !== "string" || !/^-?(?:\d+)(?:\.\d+)?$/.test(input)) throw new TypeError("Exact decimal codec requires decimal text");
  return input;
}

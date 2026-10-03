import { types } from "node:util";
import { SqlPostCommitError } from "@bolt/database";
import type { Entity } from "./entity.ts";
import { entries } from "./entity.ts";
import { quoteIdentifier, quoteTable } from "./expressions.ts";

/** Temporary key storage derives the engine's exact column types without inheriting IDENTITY. */
export function mssqlCapture<T extends object>(entity: Entity<T>, deleted = false): { prefix: string; output: string; finish: string } {
  const q = (name: string): string => quoteIdentifier(name, "mssql");
  const table = quoteTable(entity.table, "mssql");
  const capture = `[#bolt_keys_${crypto.randomUUID().replaceAll("-", "")}]`;
  const keys = entity.keys.map(key => entity.columns[key].name ?? key);
  // UNION ALL prevents IDENTITY transfer even when SQL Server optimizes away a constant CROSS JOIN.
  const keyColumns = keys.map(name => q(name)).join(", ");
  const prefix = `SELECT TOP (0) ${keyColumns} INTO ${capture} FROM ${table} UNION ALL SELECT TOP (0) ${keyColumns} FROM ${table}; `;
  const output = ` OUTPUT ${keys.map(name => `${deleted ? "DELETED" : "INSERTED"}.${q(name)}`).join(", ")} INTO ${capture} (${keys.map(q).join(", ")})`;
  const projection = deleted
    ? entity.keys.map(key => `[bolt_keys].${q(entity.columns[key].name ?? key)} AS ${q(key)}`).join(", ")
    : entries(entity).map(([key, column]) => `[bolt_row].${q(column.name ?? key)} AS ${q(key)}`).join(", ");
  const source = deleted ? `${capture} AS [bolt_keys]` : `${table} AS [bolt_row] INNER JOIN ${capture} AS [bolt_keys] ON ${keys.map(name => `[bolt_row].${q(name)} = [bolt_keys].${q(name)}`).join(" AND ")}`;
  return { prefix, output, finish: `; SELECT ${projection} FROM ${source}; DROP TABLE ${capture}` };
}

/** Reject accessors/proxies/frozen properties before SQL, so reconciliation does not call arbitrary setters. */
export function assertWritable<T extends object>(entity: Entity<T>, instance: object): void {
  if (types.isProxy(instance)) throw new TypeError("ORM writes require a non-proxy entity instance");
  for (const [key] of entries(entity)) {
    const descriptor = Object.getOwnPropertyDescriptor(instance, key);
    if (descriptor ? !("value" in descriptor) || !descriptor.writable : !Object.isExtensible(instance)) throw new TypeError(`Entity property ${key} must be a writable data property`);
  }
}

export function publish<T extends object>(entity: Entity<T>, instance: object, persisted: T, keys: readonly string[] = entries(entity).map(([key]) => key)): void {
  for (const key of keys) {
    const existing = Object.getOwnPropertyDescriptor(instance, key);
    Object.defineProperty(instance, key, existing ? { ...existing, value: (persisted as Record<string, unknown>)[key] } : { value: (persisted as Record<string, unknown>)[key], writable: true, configurable: true, enumerable: true });
  }
}

/** SQL committed, but an externally frozen/mutated object prevented publication. Retrying writes is unsafe. */
export class OrmReconciliationError extends Error {
  readonly committed = true;
  public constructor(cause: unknown) { super("SQL committed but entity reconciliation failed; discard the session and reload persisted state", { cause }); this.name = "OrmReconciliationError"; }
}

/** A successful insert's result remains available when committed SQL subsequently fails connection cleanup. */
export class OrmPostCommitError<T> extends SqlPostCommitError {
  public constructor(cause: SqlPostCommitError, public readonly result: T) { super(cause); this.name = "OrmPostCommitError"; }
}

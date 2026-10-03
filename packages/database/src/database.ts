import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  Database as SQLiteDatabase,
  type Changes,
  type SQLQueryBindings,
  type Statement,
} from "bun:sqlite";

export type DatabaseState = "running" | "stopped";

export interface Migration {
  readonly id: string;
  up(database: Database): void;
}

export interface DatabaseOptions {
  readonly busyTimeout?: number;
  readonly create?: boolean;
  readonly filename?: string;
  readonly foreignKeys?: boolean;
  readonly migrations?: readonly Migration[];
  readonly readonly?: boolean;
  readonly safeIntegers?: boolean;
  readonly strict?: boolean;
  readonly wal?: boolean;
}

export interface DatabaseTransaction<
  Arguments extends unknown[],
  Result,
> {
  (...arguments_: Arguments): Result;
  deferred(...arguments_: Arguments): Result;
  exclusive(...arguments_: Arguments): Result;
  immediate(...arguments_: Arguments): Result;
}

interface ResolvedDatabaseOptions {
  readonly busyTimeout: number;
  readonly create: boolean;
  readonly filename: string;
  readonly foreignKeys: boolean;
  readonly readonly: boolean;
  readonly safeIntegers: boolean;
  readonly strict: boolean;
  readonly wal: boolean;
}

const MIGRATIONS_TABLE = "__bolt_migrations";

export class Database {
  readonly #migrations = new Map<string, Migration>();
  readonly #options: ResolvedDatabaseOptions;
  #connection?: SQLiteDatabase;
  #state: DatabaseState = "stopped";

  private constructor(options: DatabaseOptions) {
    this.#options = resolveOptions(options);
    this.register(...(options.migrations ?? []));
  }

  public static create(options: DatabaseOptions = {}): Database {
    return new Database(options);
  }

  public get connection(): SQLiteDatabase {
    return this.getConnection();
  }

  public get filename(): string {
    return this.#options.filename;
  }

  public get isConnected(): boolean {
    return this.#state === "running";
  }

  public get state(): DatabaseState {
    return this.#state;
  }

  public migrate(): readonly string[] {
    if (this.#options.readonly) {
      if (this.#migrations.size > 0) {
        throw new Error("Cannot run migrations on a readonly database");
      }

      return [];
    }

    const connection = this.getConnection();
    connection.run(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );

    const applied = new Set(
      connection
        .query<{ id: string }, []>(`SELECT id FROM ${MIGRATIONS_TABLE}`)
        .all()
        .map(({ id }) => id),
    );
    const pending = this.orderedMigrations().filter(
      (migration) => !applied.has(migration.id),
    );

    if (pending.length === 0) {
      return [];
    }

    const record = connection.query<unknown, { id: string }>(
      `INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($id)`,
    );
    const apply = connection.transaction(() => {
      for (const migration of pending) {
        const result: unknown = migration.up(this);

        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError(
            `Migration ${migration.id} returned a Promise; SQLite migrations must be synchronous`,
          );
        }

        record.run({ id: migration.id });
      }
    });

    apply.immediate();

    return Object.freeze(pending.map(({ id }) => id));
  }

  public query<
    Row = unknown,
    Parameters extends
      | SQLQueryBindings
      | SQLQueryBindings[] = SQLQueryBindings[],
  >(
    sql: string,
  ): Statement<
    Row,
    Parameters extends any[] ? Parameters : [Parameters]
  > {
    return this.getConnection().query<Row, Parameters>(sql);
  }

  public register(...migrations: readonly Migration[]): this {
    if (this.#state !== "stopped") {
      throw new Error("Migrations can only be registered while the database is stopped");
    }

    const registeredIds = new Set(this.#migrations.keys());

    for (const migration of migrations) {
      validateMigration(migration, registeredIds);
      registeredIds.add(migration.id);
    }

    for (const migration of migrations) {
      this.#migrations.set(migration.id, migration);
    }

    return this;
  }

  public run<Parameters extends SQLQueryBindings[]>(
    sql: string,
    ...bindings: Parameters[]
  ): Changes {
    return this.getConnection().run<Parameters>(sql, ...bindings);
  }

  public start(): void {
    if (this.#state === "running") {
      return;
    }

    ensureParentDirectory(this.#options);

    const connection = new SQLiteDatabase(this.#options.filename, {
      create: this.#options.create,
      readonly: this.#options.readonly,
      safeIntegers: this.#options.safeIntegers,
      strict: this.#options.strict,
    });

    this.#connection = connection;
    this.#state = "running";

    try {
      configureConnection(connection, this.#options);
      this.migrate();
    } catch (error) {
      this.#connection = undefined;
      this.#state = "stopped";

      try {
        connection.close(true);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Database failed to start and close cleanly",
        );
      }

      throw error;
    }
  }

  public stop(): void {
    const connection = this.#connection;

    if (!connection) {
      return;
    }

    this.#connection = undefined;
    this.#state = "stopped";
    connection.close(true);
  }

  public transaction<Arguments extends unknown[], Result>(
    callback: (...arguments_: Arguments) => Result,
  ): DatabaseTransaction<Arguments, Result> {
    return this.getConnection().transaction(callback);
  }

  private getConnection(): SQLiteDatabase {
    if (!this.#connection) {
      throw new Error("Database has not been started");
    }

    return this.#connection;
  }

  private orderedMigrations(): Migration[] {
    return [...this.#migrations.values()].sort((left, right) => {
      if (left.id === right.id) {
        return 0;
      }

      return left.id < right.id ? -1 : 1;
    });
  }
}

function configureConnection(
  connection: SQLiteDatabase,
  options: ResolvedDatabaseOptions,
): void {
  connection.run(`PRAGMA busy_timeout = ${options.busyTimeout}`);

  if (options.foreignKeys) {
    connection.run("PRAGMA foreign_keys = ON");
  }

  if (options.wal && !options.readonly && !isMemoryDatabase(options.filename)) {
    connection.run("PRAGMA journal_mode = WAL");
  }
}

function defaultFilename(): string {
  if (Bun.env.NODE_ENV === "test") {
    return ":memory:";
  }

  return Bun.env["DATABASE_PATH"] ?? "storage/database.sqlite";
}

function ensureParentDirectory(options: ResolvedDatabaseOptions): void {
  if (
    options.readonly ||
    !options.create ||
    isMemoryDatabase(options.filename)
  ) {
    return;
  }

  const parent = dirname(options.filename);

  if (parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
}

function isMemoryDatabase(filename: string): boolean {
  return filename === "" || filename === ":memory:";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function resolveOptions(options: DatabaseOptions): ResolvedDatabaseOptions {
  const readonly = options.readonly ?? false;
  const busyTimeout = options.busyTimeout ?? 5_000;

  if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
    throw new RangeError("Database busyTimeout must be a non-negative safe integer");
  }

  if (readonly && options.create === true) {
    throw new TypeError("A readonly database cannot create a database file");
  }

  return {
    busyTimeout,
    create: options.create ?? !readonly,
    filename: options.filename ?? defaultFilename(),
    foreignKeys: options.foreignKeys ?? true,
    readonly,
    safeIntegers: options.safeIntegers ?? false,
    strict: options.strict ?? true,
    wal: options.wal ?? true,
  };
}

function validateMigration(
  migration: Migration,
  registeredIds: ReadonlySet<string>,
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(migration.id)) {
    throw new TypeError(
      "Migration ids must start with an alphanumeric character and contain only letters, numbers, dots, underscores, or hyphens",
    );
  }

  if (registeredIds.has(migration.id)) {
    throw new Error(`Migration ${migration.id} is already registered`);
  }

  if (typeof migration.up !== "function") {
    throw new TypeError(`Migration ${migration.id} must define an up function`);
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLock, createSqlTransport } from "./sql-transports.ts";
import type { SqlDatabaseOptions, SqlDialect, SqlExecutor, SqlOutputParameter, SqlOutputResult, SqlResult, SqlSession, SqlTransactionOptions, SqlTransport, SqlValue } from "./sql-types.ts";

export type SqlDatabaseState = "stopped" | "starting" | "running" | "closing";
/** COMMIT was acknowledged; callers must not treat cleanup failure as rollback. */
export class SqlPostCommitError extends Error {
  readonly committed = true;
  constructor(cause: unknown) {
    super("SQL transaction committed, but session cleanup failed", { cause });
    this.name = "SqlPostCommitError";
  }
}
const sessionContext = new AsyncLocalStorage<SqlDatabase>();

/** Async database with bounded native pools and explicit pinned transaction scopes. */
export class SqlDatabase implements SqlExecutor {
  readonly dialect: SqlDialect;
  readonly #options: SqlDatabaseOptions;
  readonly #lifecycle = new AsyncLock();
  #transport?: SqlTransport;
  #state: SqlDatabaseState = "stopped";
  #pending = 0;
  #drain?: () => void;
  private constructor(options: SqlDatabaseOptions) { this.#options = { ...options }; this.dialect = options.dialect; }
  static create(options: SqlDatabaseOptions): SqlDatabase { return new SqlDatabase(options); }
  get state(): SqlDatabaseState { return this.#state; }
  get isConnected(): boolean { return this.#state === "running"; }
  async start(): Promise<void> {
    if (sessionContext.getStore() === this) throw new Error("Cannot change database lifecycle from inside its session");
    await this.#lifecycle.run(async () => {
      if (this.#state === "running") return;
      this.#state = "starting";
      let transport: SqlTransport | undefined;
      try {
        transport = createSqlTransport(this.#options);
        await transport.connect();
        this.#transport = transport;
        this.#state = "running";
      } catch (error) {
        this.#state = "stopped";
        if (transport) {
          try { await transport.close(); } catch (closeError) { throw new AggregateError([error, closeError], "SQL connection failed to start and close"); }
        }
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    if (sessionContext.getStore() === this) throw new Error("Cannot close a database from inside its active session");
    await this.#lifecycle.run(async () => {
      if (!this.#transport) return;
      this.#state = "closing";
      if (this.#pending) await new Promise<void>((resolve) => { this.#drain = resolve; });
      try { await this.#transport.close(); } finally { this.#transport = undefined; this.#state = "stopped"; }
    });
  }
  async stop(): Promise<void> { await this.close(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
    return this.withSession((session) => session.execute<Row>(sql, parameters));
  }
  async executeWithOutput<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[], output: readonly SqlOutputParameter[]): Promise<SqlOutputResult<Row>> {
    return this.withSession(session => session.executeWithOutput!<Row>(sql, parameters, output));
  }
  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>, options?: SqlTransactionOptions): Promise<T> {
    return this.withSession((session) => session.transaction(callback, options));
  }
  /** The executor becomes invalid when the callback finishes. Never retain it. */
  async withSession<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (sessionContext.getStore() === this) throw new Error("Use the scoped SQL executor inside a transaction or pinned session");
    if (this.#state !== "running" || !this.#transport) throw new Error("SQL database is not running");
    const transport = this.#transport;
    this.#pending++;
    let session: SqlSession | undefined;
    let scope: ScopedExecutor | undefined;
    let result!: T;
    let operationFailed = false;
    let operationError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      session = await transport.reserve();
      scope = new ScopedExecutor(this.dialect, session);
      result = await sessionContext.run(this, () => callback(scope!));
    } catch (error) {
      // A failed advisory-lock release can leave session-owned state behind.
      // Providers with discard support must never pool that physical connection.
      operationFailed = true; operationError = error;
      try { await session?.invalidate?.(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    } finally {
      try { if (scope) await scope.finish(); } catch (error) { cleanupErrors.push(error); }
      try { await session?.release(); } catch (error) { cleanupErrors.push(error); }
      this.#pending--;
      if (!this.#pending) { this.#drain?.(); this.#drain = undefined; }
    }
    if (cleanupErrors.length) {
      const errors = operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors;
      const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, "SQL operation and session cleanup failed");
      // A previous successful transaction in a pinned session must not relabel
      // a later callback failure as successful application work.
      if (!operationFailed && scope?.hasCommitted) throw new SqlPostCommitError(cause);
      throw cause;
    }
    if (operationFailed) throw operationError;
    return result;
  }
}

let savepointSequence = 0;
class ScopedExecutor implements SqlExecutor {
  readonly dialect: SqlDialect;
  readonly #session: SqlSession;
  readonly #lock = new AsyncLock();
  readonly #inTransaction: boolean;
  #active = true;
  #childActive = false;
  #committed = false;
  constructor(dialect: SqlDialect, session: SqlSession, inTransaction = false) { this.dialect = dialect; this.#session = session; this.#inTransaction = inTransaction; }
  get hasCommitted(): boolean { return this.#committed; }
  async execute<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
    this.assertActive();
    if (!sql.trim()) throw new TypeError("SQL statement cannot be empty");
    return this.#lock.run(() => this.#session.execute<Row>(sql, parameters));
  }
  async executeWithOutput<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[], output: readonly SqlOutputParameter[]): Promise<SqlOutputResult<Row>> {
    this.assertActive();
    if (!sql.trim()) throw new TypeError("SQL statement cannot be empty");
    if (!this.#session.executeWithOutput) throw new Error(`The ${this.dialect} transport does not support output parameters`);
    return this.#lock.run(() => this.#session.executeWithOutput!<Row>(sql, parameters, output));
  }
  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>, options: SqlTransactionOptions = {}): Promise<T> {
    this.assertActive();
    if (this.#inTransaction && (options.isolation || options.sqliteMode)) throw new Error("Nested transactions cannot change isolation or locking mode");
    const begin = transactionBegin(this.dialect, options);
    this.#childActive = true;
    try {
      return await this.#lock.run(async () => {
        const savepoint = `bolt_sp_${++savepointSequence}`;
        if (this.#inTransaction) await this.#session.execute(this.dialect === "mssql" ? `SAVE TRANSACTION ${savepoint}` : `SAVEPOINT ${savepoint}`);
        else for (const statement of begin) await this.#session.execute(statement);
        const child = new ScopedExecutor(this.dialect, this.#session, true);
        try {
          const value = await callback(child);
          await child.finish();
          if (!this.#inTransaction) { await this.#session.execute("COMMIT"); this.#committed = true; }
          else if (this.dialect !== "oracle" && this.dialect !== "mssql") await this.#session.execute(`RELEASE SAVEPOINT ${savepoint}`);
          return value;
        } catch (error) {
          await child.finish();
          try {
            await this.#session.execute(this.#inTransaction ? (this.dialect === "mssql" ? `ROLLBACK TRANSACTION ${savepoint}` : `ROLLBACK TO SAVEPOINT ${savepoint}`) : "ROLLBACK");
            if (this.#inTransaction && this.dialect !== "oracle" && this.dialect !== "mssql") await this.#session.execute(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (rollbackError) { throw new AggregateError([error, rollbackError], "SQL transaction failed to roll back"); }
          throw error;
        }
      });
    } finally { this.#childActive = false; }
  }
  async finish(): Promise<void> { this.#active = false; await this.#lock.run(async () => {}); }
  private assertActive(): void {
    if (!this.#active) throw new Error("SQL executor scope has ended");
    if (this.#childActive) throw new Error("Use the nested transaction executor while its callback is active");
  }
}

function transactionBegin(dialect: SqlDialect, options: SqlTransactionOptions): readonly string[] {
  const isolation = options.isolation;
  if (isolation && !["read uncommitted", "read committed", "repeatable read", "serializable"].includes(isolation)) throw new TypeError("Invalid transaction isolation level");
  if (options.sqliteMode && !["deferred", "immediate", "exclusive"].includes(options.sqliteMode)) throw new TypeError("Invalid SQLite transaction mode");
  if (dialect !== "sqlite" && options.sqliteMode) throw new Error("sqliteMode is only supported by SQLite");
  if (dialect === "sqlite") {
    if (isolation && isolation !== "serializable") throw new Error("SQLite executor supports serializable isolation only");
    return [`BEGIN ${(options.sqliteMode ?? "immediate").toUpperCase()}`];
  }
  const level = isolation?.toUpperCase();
  if (dialect === "postgresql") return [level ? `BEGIN ISOLATION LEVEL ${level}` : "BEGIN"];
  if (dialect === "mysql" || dialect === "mariadb") return [...(level ? [`SET TRANSACTION ISOLATION LEVEL ${level}`] : []), "START TRANSACTION"];
  if (dialect === "mssql") return [...(level ? [`SET TRANSACTION ISOLATION LEVEL ${level}`] : []), "BEGIN TRANSACTION"];
  if (isolation && isolation !== "read committed" && isolation !== "serializable") throw new Error("Oracle supports read committed or serializable transaction isolation");
  return [`SET TRANSACTION ISOLATION LEVEL ${level ?? "READ COMMITTED"}`];
}

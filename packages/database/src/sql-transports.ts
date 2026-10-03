import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SQL } from "bun";
import { Database as SQLite } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { SqlDatabaseOptions, SqlDialect, SqlResult, SqlSession, SqlTransport, SqlValue } from "./sql-types.ts";

/** FIFO lock shared by the SQLite connection and every reservation. */
export class AsyncLock {
  #tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    return release;
  }
  async run<T>(callback: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await callback(); } finally { release(); }
  }
}

export function createSqlTransport(options: SqlDatabaseOptions): SqlTransport {
  if (options.transport) {
    if (options.transport.dialect !== options.dialect) throw new TypeError("Transport dialect does not match the database dialect");
    return options.transport;
  }
  if (options.dialect === "sqlite") return new SQLiteTransport(options);
  if (options.dialect === "postgresql" || options.dialect === "mysql" || options.dialect === "mariadb") return new BunSqlTransport(options);
  throw new Error(`No native ${options.dialect} transport is available; configure an explicit SqlTransport`);
}

const sqliteFileLocks = new Map<string, { lock: AsyncLock; users: number }>();
class SQLiteTransport implements SqlTransport {
  readonly dialect = "sqlite";
  #lock = new AsyncLock();
  #lockKey?: string;
  readonly #options: SqlDatabaseOptions;
  #connection?: SQLite;
  constructor(options: SqlDatabaseOptions) { this.#options = options; }
  async connect(): Promise<void> {
    const filename = this.#options.filename ?? ":memory:";
    const timeout = this.#options.busyTimeout ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new RangeError("busyTimeout must be a non-negative safe integer");
    if (filename !== ":memory:" && filename !== "" && !this.#options.readonly) mkdirSync(dirname(resolve(filename)), { recursive: true });
    const connection = new SQLite(filename, { create: !this.#options.readonly, readonly: this.#options.readonly ?? false, strict: true });
    try {
      connection.run(`PRAGMA busy_timeout = ${timeout}`);
      connection.run("PRAGMA foreign_keys = ON");
      if (this.#options.wal !== false && !this.#options.readonly && filename !== ":memory:") connection.run("PRAGMA journal_mode = WAL");
      this.#connection = connection;
      if (filename !== ":memory:" && filename !== "") {
        const absolute = resolve(filename);
        this.#lockKey = process.platform === "win32" ? absolute.toLowerCase() : absolute;
        const entry = sqliteFileLocks.get(this.#lockKey) ?? { lock: new AsyncLock(), users: 0 };
        entry.users++;
        sqliteFileLocks.set(this.#lockKey, entry);
        this.#lock = entry.lock;
      }
    } catch (error) { connection.close(); throw error; }
  }
  async reserve(): Promise<SqlSession> {
    const releaseLock = await this.#lock.acquire();
    const connection = this.#connection;
    if (!connection) { releaseLock(); throw new Error("SQLite transport is closed"); }
    let released = false;
    return {
      async execute<Row extends Record<string, unknown>>(sql: string, values: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
        if (released) throw new Error("SQL session has been released");
        const parameters: SQLQueryBindings[] = values.map((value) => value instanceof Date ? value.toISOString() : typeof value === "boolean" ? Number(value) : value);
        // Statements are deliberately finalized; arbitrary SQL must not grow an unbounded cache.
        const statement = connection.prepare<Row, SQLQueryBindings[]>(sql);
        try {
          if (statement.columnNames.length === 0) {
            const before = connection.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total;
            const changes = statement.run(...parameters);
            const after = connection.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total;
            const affectedRows = after === before ? 0 : changes.changes;
            return { rows: [], affectedRows, ...(affectedRows && /^\s*(?:INSERT|REPLACE)\b/i.test(sql) ? { insertId: changes.lastInsertRowid } : {}) };
          }
          const before = connection.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total;
          const rows = statement.all(...parameters);
          const after = connection.query<{ total: number }, []>("SELECT total_changes() AS total").get()!.total;
          const affectedRows = after === before ? 0 : connection.query<{ count: number }, []>("SELECT changes() AS count").get()!.count;
          return { rows, affectedRows };
        } finally { statement.finalize(); }
      },
      async release() { if (!released) { released = true; releaseLock(); } },
    };
  }
  async close(): Promise<void> {
    await this.#lock.run(async () => {
      this.#connection?.close(); this.#connection = undefined;
      if (this.#lockKey) {
        const entry = sqliteFileLocks.get(this.#lockKey);
        if (entry && --entry.users === 0) sqliteFileLocks.delete(this.#lockKey);
        this.#lockKey = undefined;
      }
    });
  }
}

class BunSqlTransport implements SqlTransport {
  readonly dialect: SqlDialect;
  readonly #sql: SQL;
  constructor(options: SqlDatabaseOptions) {
    this.dialect = options.dialect;
    if (!options.url) throw new TypeError(`${options.dialect} requires a connection URL`);
    const url = new URL(options.url);
    const expected = options.dialect === "postgresql" ? ["postgres:", "postgresql:"] : ["mysql:", "mysql2:", "mariadb:"];
    if (!expected.includes(url.protocol)) throw new TypeError("Connection URL protocol does not match the database dialect");
    // Bun 1.4 fails caching_sha2_password RSA authentication at 20 UTF-8 bytes.
    // Keep credentials intact and require TLS; never retry with a truncated password.
    if (options.dialect === "mysql" && options.allowPublicKeyRetrieval === true && !requiresTls(options, url) && Buffer.byteLength(decodeURIComponent(url.password), "utf8") >= 20) {
      throw Object.assign(new TypeError("Bun MySQL RSA authentication requires TLS for passwords of 20 UTF-8 bytes or more. Configure required TLS with certificate verification."), { code: "BOLT_MYSQL_TLS_REQUIRED" });
    }
    for (const key of ["maxConnections", "connectionTimeout", "idleTimeout"] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "maxConnections" ? 1 : 0))) throw new RangeError(`${key} has an invalid value`);
    }
    this.#sql = new SQL(options.url, {
      adapter: options.dialect === "postgresql" ? "postgres" : "mysql",
      ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
      ...(options.connectionTimeout === undefined ? {} : { connectionTimeout: options.connectionTimeout }),
      ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
      ...(options.tls === undefined ? {} : { tls: options.tls }),
      ...(options.allowPublicKeyRetrieval === undefined ? {} : { allowPublicKeyRetrieval: options.allowPublicKeyRetrieval }),
    });
  }
  async connect(): Promise<void> { await this.#sql.connect(); }
  async close(): Promise<void> { await this.#sql.close(); }
  async reserve(): Promise<SqlSession> {
    const native = await this.#sql.reserve();
    let released = false;
    return {
      async execute<Row extends Record<string, unknown>>(sql: string, parameters: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
        if (released) throw new Error("SQL session has been released");
        const result = await native.unsafe<Row[]>(sql, [...parameters]);
        const metadata = result as Row[] & { count?: number; command?: string; affectedRows?: number | null; lastInsertRowid?: string | number | bigint | null; insertId?: string | number | bigint | null };
        const insertId = metadata.insertId ?? metadata.lastInsertRowid;
        const affectedRows = metadata.affectedRows ?? (["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"].includes(metadata.command ?? "") ? metadata.count ?? 0 : 0);
        return { rows: Array.from(result), affectedRows, ...(insertId == null ? {} : { insertId }) };
      },
      async release() { if (!released) { released = true; native.release(); } },
    };
  }
}

function requiresTls(options: SqlDatabaseOptions, url: URL): boolean {
  const tls = options.tls;
  // An explicit option takes precedence over a URL SSL mode in Bun.
  if (tls !== undefined) return tls === true || typeof tls === "object" || tls === "require" || tls === "verify-ca" || tls === "verify-full";
  return ["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
}

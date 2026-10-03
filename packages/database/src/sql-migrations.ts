import { createHash } from "node:crypto";
import type { SqlDatabase } from "./sql-database.ts";
import type { SqlDialect, SqlExecutor } from "./sql-types.ts";

export interface SqlMigration {
  readonly id: string;
  /** SHA-256 of immutable migration content; never change an applied migration. */
  readonly checksum: string;
  readonly transactional?: boolean;
  up(executor: SqlExecutor): Promise<void>;
}
export interface SqlMigrationStatus {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: string | null;
  readonly state: "pending" | "applied" | "dirty" | "missing";
}
export interface SqlMigrationOptions {
  readonly tableName?: string;
  readonly lockTimeoutSeconds?: number;
  /** Override for engines requiring a privileged or deployment-specific lock. */
  readonly lock?: <T>(executor: SqlExecutor, callback: () => Promise<T>) => Promise<T>;
}

/** Checksummed, forward-only SQL migrations. MySQL/Oracle DDL requires explicit non-atomic opt-in. */
export class SqlMigrator {
  readonly #database: SqlDatabase;
  readonly #migrations: readonly SqlMigration[];
  readonly #options: SqlMigrationOptions;
  readonly #table: string;
  constructor(database: SqlDatabase, migrations: readonly SqlMigration[], options: SqlMigrationOptions = {}) {
    this.#database = database;
    this.#options = { ...options };
    this.#table = options.tableName ?? "__bolt_sql_migrations";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/.test(this.#table)) throw new TypeError("Migration table name must be a simple identifier of at most 30 characters");
    const timeout = options.lockTimeoutSeconds ?? 30;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new RangeError("Migration lock timeout must be a non-negative safe integer");
    const ids = new Set<string>();
    for (const migration of migrations) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,189}$/.test(migration.id)) throw new TypeError("Invalid SQL migration id");
      if (ids.has(migration.id)) throw new Error(`Duplicate migration ${migration.id}`);
      ids.add(migration.id);
      if (!/^[a-f0-9]{64}$/.test(migration.checksum)) throw new TypeError(`Migration ${migration.id} needs a lowercase SHA-256 checksum`);
      if (typeof migration.up !== "function") throw new TypeError(`Migration ${migration.id} needs an async up function`);
      if (["mysql", "mariadb", "oracle"].includes(database.dialect) && migration.transactional !== false) throw new Error(`Migration ${migration.id} must explicitly set transactional: false for ${database.dialect}, whose DDL can commit implicitly`);
    }
    this.#migrations = Object.freeze([...migrations].map((migration) => Object.freeze({ id: migration.id, checksum: migration.checksum, transactional: migration.transactional, up: migration.up.bind(migration) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  async migrate(): Promise<readonly string[]> {
    return this.locked(async (executor) => {
      await this.createTable(executor);
      const status = await this.status(executor);
      for (const row of status) {
        if (row.state === "dirty") throw new Error(`Migration ${row.id} is dirty; reconcile the schema and migration record before proceeding`);
        if (row.state === "missing") throw new Error(`Applied migration ${row.id} is missing from the migration catalog`);
      }
      const pending = new Set(status.filter((row) => row.state === "pending").map((row) => row.id));
      const applied: string[] = [];
      for (const migration of this.#migrations) {
        if (!pending.has(migration.id)) continue;
        const apply = async (scope: SqlExecutor): Promise<void> => {
          const placeholders = bind(scope.dialect, 3);
          await scope.execute(`INSERT INTO ${this.table(scope.dialect)} (id, checksum, state) VALUES (${placeholders.join(", ")})`, [migration.id, migration.checksum, "dirty"]);
          await migration.up(scope);
          await scope.execute(`UPDATE ${this.table(scope.dialect)} SET state = ${bind(scope.dialect, 1)[0]}, applied_at = ${bind(scope.dialect, 2)[1]} WHERE id = ${bind(scope.dialect, 3)[2]}`, ["applied", new Date().toISOString(), migration.id]);
        };
        if (migration.transactional !== false) await executor.transaction(apply);
        else await apply(executor);
        applied.push(migration.id);
      }
      return Object.freeze(applied);
    });
  }
  async migrationStatus(): Promise<readonly SqlMigrationStatus[]> {
    return this.locked(async (executor) => { await this.createTable(executor); return this.status(executor); });
  }
  private async createTable(executor: SqlExecutor): Promise<void> {
    const definition = `${this.table(executor.dialect)} (id VARCHAR(190) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, applied_at VARCHAR(32))`;
    if (executor.dialect === "mssql") await executor.execute(`IF OBJECT_ID('${this.#table}', 'U') IS NULL CREATE TABLE ${definition}`);
    else if (executor.dialect === "oracle") await executor.execute(`BEGIN EXECUTE IMMEDIATE 'CREATE TABLE ${definition}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`);
    else await executor.execute(`CREATE TABLE IF NOT EXISTS ${definition}`);
  }
  private async status(executor: SqlExecutor): Promise<readonly SqlMigrationStatus[]> {
    const { rows } = await executor.execute<{ id: string; checksum: string; state: string; applied_at: string | null }>(`SELECT id AS "id", checksum AS "checksum", state AS "state", applied_at AS "applied_at" FROM ${this.table(executor.dialect)} ORDER BY id`);
    const recorded = new Map(rows.map((row) => [row.id, row]));
    const status: SqlMigrationStatus[] = this.#migrations.map((migration) => {
      const row = recorded.get(migration.id);
      if (row && row.checksum !== migration.checksum) throw new Error(`Checksum mismatch for migration ${migration.id}`);
      return { id: migration.id, checksum: migration.checksum, appliedAt: row?.applied_at ?? null, state: !row ? "pending" : row.state === "applied" ? "applied" : "dirty" };
    });
    const known = new Set(this.#migrations.map((migration) => migration.id));
    for (const row of rows) if (!known.has(row.id)) status.push({ id: row.id, checksum: row.checksum, appliedAt: row.applied_at, state: row.state === "applied" ? "missing" : "dirty" });
    return Object.freeze(status.map((entry) => Object.freeze(entry)));
  }
  private async locked<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#database.withSession(async (executor) => {
      if (this.#options.lock) return this.#options.lock(executor, () => callback(executor));
      if (executor.dialect === "sqlite") return executor.transaction(callback, { sqliteMode: "immediate" });
      const name = `bolt:migrations:${this.#table}`;
      if (executor.dialect === "postgresql") {
        const key = createHash("sha256").update(name).digest().readBigInt64BE();
        const deadline = Date.now() + (this.#options.lockTimeoutSeconds ?? 30) * 1000;
        for (;;) {
          const lock = await executor.execute<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [key]);
          if (lock.rows[0]?.acquired) break;
          if (Date.now() >= deadline) throw new Error("Could not acquire SQL migration lock");
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        }
        try { return await callback(executor); } finally { await executor.execute("SELECT pg_advisory_unlock($1)", [key]); }
      }
      if (executor.dialect === "mysql" || executor.dialect === "mariadb") {
        const lock = await executor.execute<{ acquired: number | null }>("SELECT GET_LOCK(?, ?) AS acquired", [name, this.#options.lockTimeoutSeconds ?? 30]);
        if (Number(lock.rows[0]?.acquired) !== 1) throw new Error("Could not acquire SQL migration lock");
        try { return await callback(executor); } finally { await executor.execute("SELECT RELEASE_LOCK(?)", [name]); }
      }
      if (executor.dialect === "mssql") {
        const lock = await executor.execute<{ acquired: number }>("DECLARE @result INT; EXEC @result = sys.sp_getapplock @Resource = @p1, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = @p2; SELECT @result AS acquired", [name, (this.#options.lockTimeoutSeconds ?? 30) * 1000]);
        if (lock.rows[0]?.acquired === undefined || lock.rows[0].acquired < 0) throw new Error("Could not acquire SQL migration lock");
        try { return await callback(executor); } finally { await executor.execute("EXEC sys.sp_releaseapplock @Resource = @p1, @LockOwner = 'Session'", [name]); }
      }
      if (!executor.executeWithOutput) throw new Error("Oracle migrations require output-bind support and EXECUTE on SYS.DBMS_LOCK, or an explicit SqlMigrationOptions.lock implementation");
      const schema = await executor.execute<{ schema: string }>('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') AS "schema" FROM dual');
      let handle: unknown;
      try {
        const acquired = await executor.executeWithOutput("DECLARE l_handle VARCHAR2(128); l_result PLS_INTEGER; BEGIN DBMS_LOCK.ALLOCATE_UNIQUE_AUTONOMOUS(:p1, l_handle); l_result := DBMS_LOCK.REQUEST(lockhandle => l_handle, lockmode => DBMS_LOCK.X_MODE, timeout => :p2, release_on_commit => FALSE); IF l_result != 0 THEN RAISE_APPLICATION_ERROR(-20001, 'Bolt migration lock could not be acquired'); END IF; :p3 := l_handle; END;", [`${name}:${schema.rows[0]?.schema ?? ""}`, this.#options.lockTimeoutSeconds ?? 30], [{ type: "string", size: 128 }]);
        handle = acquired.output[0];
        if (typeof handle !== "string" || !handle) throw new Error("Oracle migration lock returned no handle");
      } catch (cause) {
        throw new Error("Oracle migration lock could not be acquired; the account requires EXECUTE on SYS.DBMS_LOCK and output-bind support. SqlMigrationOptions.lock can provide a deployment-specific lock", { cause });
      }
      try { return await callback(executor); }
      finally {
        await executor.execute("DECLARE l_result PLS_INTEGER; BEGIN l_result := DBMS_LOCK.RELEASE(:p1); IF l_result != 0 THEN RAISE_APPLICATION_ERROR(-20002, 'Bolt migration lock could not be released'); END IF; END;", [handle]);
      }
    });
  }
  private table(dialect: SqlDialect): string { return dialect === "oracle" ? `"${this.#table}"` : this.#table; }
}

/** SQL-only migrations derive checksums from content instead of function serialization. */
export function sqlMigration(id: string, statements: readonly string[], options: { readonly transactional?: boolean } = {}): SqlMigration {
  const immutable = Object.freeze([...statements]);
  return Object.freeze({ id, checksum: createHash("sha256").update(JSON.stringify(immutable)).digest("hex"), ...options, async up(executor: SqlExecutor) { for (const sql of immutable) await executor.execute(sql); } });
}

function bind(dialect: SqlDialect, count: number): string[] {
  return Array.from({ length: count }, (_, index) => dialect === "postgresql" ? `$${index + 1}` : dialect === "mssql" ? `@p${index + 1}` : dialect === "oracle" ? `:p${index + 1}` : "?");
}

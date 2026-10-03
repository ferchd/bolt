import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlConnections, SqlDatabase, SqlMigrator, SqlPostCommitError, sqlMigration, type SqlExecutor, type SqlTransport } from "../src/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function database() {
  const database = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" });
  await database.start();
  return database;
}

describe("async SQL persistence", () => {
  test("opens a relative SQLite filename in the current directory", async () => {
    const filename = `bolt-relative-${crypto.randomUUID()}.sqlite`;
    const db = SqlDatabase.create({ dialect: "sqlite", filename, wal: false });
    try {
      await db.start();
      expect((await db.execute("SELECT 1 AS value")).rows).toEqual([{ value: 1 }]);
    } finally {
      await db.close();
      rmSync(filename, { force: true });
    }
  });
  test("has an explicit restartable lifecycle and rejects unsupported transports", async () => {
    const db = SqlDatabase.create({ dialect: "sqlite" });
    await expect(db.execute("SELECT 1")).rejects.toThrow("not running");
    await Promise.all([db.start(), db.start()]);
    expect(db.state).toBe("running");
    await Promise.all([db.close(), db.close()]);
    expect(db.state).toBe("stopped");
    await db.start();
    await db.close();
    for (const dialect of ["oracle", "mssql"] as const) {
      const missing = SqlDatabase.create({ dialect });
      await expect(missing.start()).rejects.toThrow("explicit SqlTransport");
      expect(missing.state).toBe("stopped");
    }
  });
  test("binds hostile text, dates, booleans and binary values without changing SQL", async () => {
    const db = await database();
    try {
      await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER, timestamp TEXT, bytes BLOB)");
      const hostile = "Robert'); DROP TABLE items; --";
      const date = new Date("2026-01-01T00:00:00.000Z");
      const bytes = new Uint8Array([0, 127, 255]);
      const inserted = await db.execute("INSERT INTO items (name, enabled, timestamp, bytes) VALUES (?, ?, ?, ?)", [hostile, true, date, bytes]);
      expect(inserted.affectedRows).toBe(1);
      expect(inserted.insertId).toBe(1);
      const selected = await db.execute("SELECT * FROM items");
      expect(selected.affectedRows).toBe(0);
      expect(selected.rows[0]).toEqual({ id: 1, name: hostile, enabled: 1, timestamp: date.toISOString(), bytes });
      expect((await db.execute("CREATE TABLE second (id INTEGER)")).affectedRows).toBe(0);
      expect((await db.execute("INSERT INTO items (name) VALUES (?) RETURNING id", ["Ada"])).affectedRows).toBe(1);
      expect((await db.execute("UPDATE items SET name = ? WHERE id = ?", ["empty", 99])).affectedRows).toBe(0);
    } finally { await db.close(); }
  });
  test("rolls back async work and keeps concurrent outsiders out of its transaction", async () => {
    const db = await database();
    const entered = deferred();
    const unblock = deferred();
    try {
      await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)");
      const transaction = db.transaction(async (tx) => {
        await tx.execute("INSERT INTO items VALUES (?)", [1]);
        entered.resolve();
        await unblock.promise;
        throw new Error("rollback");
      });
      const rejected = transaction.catch((error: unknown) => error);
      await entered.promise;
      const outside = db.execute("INSERT INTO items VALUES (?)", [2]);
      unblock.resolve();
      expect((await rejected as Error).message).toBe("rollback");
      await outside;
      expect((await db.execute("SELECT id FROM items")).rows).toEqual([{ id: 2 }]);
    } finally { unblock.resolve(); await db.close(); }
  });
  test("supports nested savepoints while guarding escaped and wrong executors", async () => {
    const db = await database();
    let escaped!: SqlExecutor;
    try {
      await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)");
      await db.transaction(async (tx) => {
        escaped = tx;
        await tx.execute("INSERT INTO items VALUES (1)");
        await expect(db.execute("INSERT INTO items VALUES (10)")).rejects.toThrow("scoped SQL executor");
        await expect(db.close()).rejects.toThrow("active session");
        await expect(tx.transaction(async (nested) => {
          await nested.execute("INSERT INTO items VALUES (2)");
          await expect(tx.execute("INSERT INTO items VALUES (3)")).rejects.toThrow("nested transaction executor");
          throw new Error("savepoint rollback");
        })).rejects.toThrow("savepoint rollback");
        await tx.execute("INSERT INTO items VALUES (4)");
      });
      await expect(escaped.execute("SELECT 1")).rejects.toThrow("scope has ended");
      expect((await db.execute("SELECT id FROM items ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 4 }]);
    } finally { await db.close(); }
  });
  test("close drains active reservations and rejects new operations", async () => {
    const db = await database();
    const entered = deferred();
    const unblock = deferred();
    const active = db.transaction(async (tx) => {
      entered.resolve();
      await unblock.promise;
      await tx.execute("SELECT 1");
    });
    await entered.promise;
    const closing = db.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(db.state).toBe("closing");
    await expect(db.execute("SELECT 1")).rejects.toThrow("not running");
    unblock.resolve();
    await Promise.all([active, closing]);
    expect(db.state).toBe("stopped");
  });
  test("enforces foreign keys and validates transaction options", async () => {
    const db = await database();
    try {
      await db.execute("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
      await db.execute("CREATE TABLE children (parent_id INTEGER REFERENCES parents(id))");
      await expect(db.execute("INSERT INTO children VALUES (?)", [99])).rejects.toThrow("FOREIGN KEY");
      await expect(db.transaction(async () => {}, { isolation: "read committed" })).rejects.toThrow("serializable");
    } finally { await db.close(); }
  });
  test("named connections clean up earlier startup on a later transport failure", async () => {
    const manager = new SqlConnections().add("primary", { dialect: "sqlite" }).add("reporting", { dialect: "oracle" });
    await expect(manager.start()).rejects.toThrow("explicit SqlTransport");
    expect(manager.get("primary").state).toBe("stopped");
    await manager.close();
    expect(() => manager.get("missing")).toThrow("Unknown SQL connection");
    expect(() => manager.add("primary", { dialect: "sqlite" })).toThrow("already registered");
  });
  test("an original custom transport pins transaction control to a single reservation", async () => {
    const commands: string[] = [];
    let reservations = 0;
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() { commands.push("close"); },
      async reserve() {
        reservations++;
        return { async execute(sql) { commands.push(sql); return { rows: [], affectedRows: 0 }; }, async release() { commands.push("release"); } };
      },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    await db.transaction(async (tx) => { await tx.execute("SELECT @p1", [7]); }, { isolation: "serializable" });
    await db.close();
    expect(reservations).toBe(1);
    expect(commands).toEqual(["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "BEGIN TRANSACTION", "SELECT @p1", "COMMIT", "release", "close"]);
  });
  test("output bindings use the current reservation and cannot escape their scope", async () => {
    let escaped!: SqlExecutor;
    let reservations = 0;
    const commands: string[] = [];
    const transport: SqlTransport = {
      dialect: "oracle", async connect() {}, async close() {},
      async reserve() {
        reservations++;
        return {
          async execute(sql) { commands.push(sql); return { rows: [], affectedRows: 0 }; },
          async executeWithOutput(sql) { commands.push(sql); return { rows: [], affectedRows: 1, output: ["9007199254740993"] }; },
          async release() { commands.push("release"); },
        };
      },
    };
    const db = SqlDatabase.create({ dialect: "oracle", transport });
    await db.start();
    try {
      await db.transaction(async executor => {
        escaped = executor;
        const result = await executor.executeWithOutput!("INSERT ... RETURNING id INTO :p1", [], [{ type: "decimal" }]);
        expect(result.output).toEqual(["9007199254740993"]);
      });
      expect(reservations).toBe(1);
      expect(commands).toEqual(["SET TRANSACTION ISOLATION LEVEL READ COMMITTED", "INSERT ... RETURNING id INTO :p1", "COMMIT", "release"]);
      await expect(escaped.executeWithOutput!("SELECT :p1", [], [{ type: "string" }])).rejects.toThrow("scope has ended");
    } finally { await db.close(); }
  });
  test("failed callbacks discard provider session state before release and output support is explicit", async () => {
    const commands: string[] = [];
    const transport: SqlTransport = {
      dialect: "oracle", async connect() {}, async close() {},
      async reserve() { return {
        async execute() { return { rows: [], affectedRows: 0 }; },
        async invalidate() { commands.push("invalidate"); },
        async release() { commands.push("release"); },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "oracle", transport });
    await db.start();
    try {
      await expect(db.withSession(async () => { throw new Error("advisory release failed"); })).rejects.toThrow("advisory release failed");
      expect(commands).toEqual(["invalidate", "release"]);
      await expect(db.executeWithOutput("BEGIN :p1 := NULL; END;", [], [{ type: "string" }])).rejects.toThrow("does not support output");
    } finally { await db.close(); }
  });
  test("acknowledged COMMIT followed by failed release is distinguishable from rollback", async () => {
    const releaseFailure = new Error("release failed");
    const commands: string[] = [];
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() {},
      async reserve() { return {
        async execute(sql) { commands.push(sql); return { rows: [], affectedRows: 0 }; },
        async release() { commands.push("release"); throw releaseFailure; },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    try {
      let error: unknown;
      try { await db.transaction(async executor => { await executor.execute("INSERT INTO items VALUES (1)"); }); } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(SqlPostCommitError);
      const committed = error as SqlPostCommitError;
      expect(committed.committed).toBe(true);
      expect(committed.cause).toBe(releaseFailure);
      expect(commands).toEqual(["BEGIN TRANSACTION", "INSERT INTO items VALUES (1)", "COMMIT", "release"]);
    } finally { await db.close(); }
    expect(db.state).toBe("stopped");
  });
  test("callback failure remains first when invalidation and release also fail", async () => {
    const operationFailure = new Error("callback failed");
    const invalidateFailure = new Error("discard failed");
    const releaseFailure = new Error("release failed");
    const commands: string[] = [];
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() {},
      async reserve() { return {
        async execute(sql) { commands.push(sql); return { rows: [], affectedRows: 0 }; },
        async invalidate() { commands.push("invalidate"); throw invalidateFailure; },
        async release() { commands.push("release"); throw releaseFailure; },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    try {
      let error: unknown;
      try { await db.transaction(async () => { throw operationFailure; }); } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).not.toBeInstanceOf(SqlPostCommitError);
      expect((error as AggregateError).errors).toEqual([operationFailure, invalidateFailure, releaseFailure]);
      expect(commands).toEqual(["BEGIN TRANSACTION", "ROLLBACK", "invalidate", "release"]);
    } finally { await db.close(); }
  });
  test("failed COMMIT with cleanup errors never reports an acknowledged commit", async () => {
    const commitFailure = new Error("commit acknowledgement failed");
    const releaseFailure = new Error("release failed");
    const commands: string[] = [];
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() {},
      async reserve() { return {
        async execute(sql) { commands.push(sql); if (sql === "COMMIT") throw commitFailure; return { rows: [], affectedRows: 0 }; },
        async release() { commands.push("release"); throw releaseFailure; },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    try {
      let error: unknown;
      try { await db.transaction(async () => {}); } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).not.toBeInstanceOf(SqlPostCommitError);
      expect((error as AggregateError).errors).toEqual([commitFailure, releaseFailure]);
      expect(commands).toEqual(["BEGIN TRANSACTION", "COMMIT", "ROLLBACK", "release"]);
    } finally { await db.close(); }
  });
  test("release failure after a read without a transaction retains its original error", async () => {
    const releaseFailure = new Error("release failed");
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() {},
      async reserve() { return {
        async execute() { return { rows: [], affectedRows: 0 }; },
        async release() { throw releaseFailure; },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    try {
      let error: unknown;
      try { await db.execute("SELECT 1"); } catch (failure) { error = failure; }
      expect(error).toBe(releaseFailure);
      expect(error).not.toBeInstanceOf(SqlPostCommitError);
    } finally { await db.close(); }
  });
  test("an earlier commit does not mask a subsequent pinned callback failure", async () => {
    const operationFailure = new Error("later work failed");
    const releaseFailure = new Error("release failed");
    const transport: SqlTransport = {
      dialect: "mssql", async connect() {}, async close() {},
      async reserve() { return {
        async execute() { return { rows: [], affectedRows: 0 }; },
        async release() { throw releaseFailure; },
      }; },
    };
    const db = SqlDatabase.create({ dialect: "mssql", transport });
    await db.start();
    try {
      let error: unknown;
      try {
        await db.withSession(async executor => {
          await executor.transaction(async () => {});
          throw operationFailure;
        });
      } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).not.toBeInstanceOf(SqlPostCommitError);
      expect((error as AggregateError).errors).toEqual([operationFailure, releaseFailure]);
    } finally { await db.close(); }
  });
});

describe("SQL migrations", () => {
  test("awaits migrations, orders them, records checksums and rejects drift", async () => {
    const db = await database();
    try {
      const first = sqlMigration("001-create", ["CREATE TABLE items (id INTEGER PRIMARY KEY)"]);
      const second = sqlMigration("002-seed", ["INSERT INTO items VALUES (1)"]);
      const runner = new SqlMigrator(db, [second, first]);
      expect((await runner.migrationStatus()).map((row) => row.state)).toEqual(["pending", "pending"]);
      expect(await runner.migrate()).toEqual(["001-create", "002-seed"]);
      expect(await runner.migrate()).toEqual([]);
      expect((await runner.migrationStatus()).map((row) => row.state)).toEqual(["applied", "applied"]);
      const changed = new SqlMigrator(db, [sqlMigration("001-create", ["CREATE TABLE changed (id INTEGER)"]), second]);
      await expect(changed.migrate()).rejects.toThrow("Checksum mismatch");
      await expect(new SqlMigrator(db, [first]).migrate()).rejects.toThrow("missing from the migration catalog");
    } finally { await db.close(); }
  });
  test("transactional migration failure rolls back its schema and records", async () => {
    const db = await database();
    try {
      const runner = new SqlMigrator(db, [sqlMigration("001-broken", ["CREATE TABLE items (id INTEGER)", "INSERT INTO nonexistent VALUES (1)"])]);
      await expect(runner.migrate()).rejects.toThrow("nonexistent");
      expect((await db.execute("SELECT name FROM sqlite_schema WHERE name = ?", ["items"])).rows).toEqual([]);
      expect((await runner.migrationStatus())[0]?.state).toBe("pending");
    } finally { await db.close(); }
  });
  test("nontransactional failure records dirty state and blocks retries", async () => {
    const db = await database();
    try {
      // A SQLite migration lock uses a transaction; test the dirty safeguard by recording a prior failure.
      const migration = sqlMigration("001-create", ["CREATE TABLE items (id INTEGER)"], { transactional: false });
      const runner = new SqlMigrator(db, [migration]);
      await runner.migrationStatus();
      await db.execute("INSERT INTO __bolt_sql_migrations (id, checksum, state) VALUES (?, ?, ?)", [migration.id, migration.checksum, "dirty"]);
      await expect(runner.migrate()).rejects.toThrow("is dirty");
      expect((await runner.migrationStatus())[0]?.state).toBe("dirty");
    } finally { await db.close(); }
  });
  test("serializes concurrent migration runners on the same SQLite file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bolt-sql-"));
    const options = { dialect: "sqlite" as const, filename: join(directory, "db.sqlite") };
    const first = SqlDatabase.create(options);
    const second = SqlDatabase.create(options);
    try {
      await first.start(); await second.start();
      const migration = sqlMigration("001-create", ["CREATE TABLE items (id INTEGER)"]);
      const results = await Promise.all([new SqlMigrator(first, [migration]).migrate(), new SqlMigrator(second, [migration]).migrate()]);
      expect(results.map((rows) => rows.length).sort()).toEqual([0, 1]);
    } finally { await first.close(); await second.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  test("requires explicit opt-in for engines with implicitly committed DDL", () => {
    for (const dialect of ["mysql", "mariadb", "oracle"] as const) {
      const db = SqlDatabase.create({ dialect });
      expect(() => new SqlMigrator(db, [sqlMigration("001-create", ["CREATE TABLE items (id INTEGER)"])])).toThrow("transactional: false");
    }
  });
});

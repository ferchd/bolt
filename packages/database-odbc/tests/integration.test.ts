import { describe, expect, test } from "bun:test";
import { SqlDatabase, SqlMigrator, sqlMigration } from "@bolt/database";
import { codecs, defineEntity, OptimisticLockError, OrmSession, Repository } from "../../orm/src/index.ts";
import { OdbcError, OdbcTransport } from "../src/index.ts";

const sqlServerConnection = process.env["BOLT_TEST_SQLSERVER_ODBC_CONNECTION"];
const oracleConnection = process.env["BOLT_TEST_ORACLE_ODBC_CONNECTION"];
const powershellExecutable = process.env["BOLT_TEST_ODBC_POWERSHELL"];
async function rejected(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected promise rejection");
}
function database(dialect: "mssql" | "oracle", connectionString: string): SqlDatabase {
  return SqlDatabase.create({ dialect, transport: new OdbcTransport({ dialect, connectionString, powershellExecutable, maxConnections: 2 }) });
}

describe.skipIf(!sqlServerConnection)("real SQL Server original ODBC transport", () => {
  test("exact codecs, OUTPUT, transactions, savepoints, concurrent migrations and ORM", async () => {
    const db = database("mssql", sqlServerConnection!);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const table = `bolt_odbc_u_${suffix}`;
    const migrationTable = `bolt_odbc_m_${suffix}`;
    await db.start();
    try {
      const exact = "12345678901234567890123456789012345678";
      const result = await db.execute("SELECT CAST(@p1 AS BIGINT) AS large, CAST(@p2 AS DECIMAL(38,0)) AS exact, CAST(@p3 AS VARBINARY(4)) AS bytes, CAST(@p4 AS NVARCHAR(50)) AS unicode, CAST(@p5 AS DATETIME2(3)) AS date, CAST(@p6 AS INT) AS nullable", [9_223_372_036_854_775_807n, exact, new Uint8Array([0, 255]), "España ☃", new Date("2026-01-01T01:02:03.123Z"), null]);
      expect(result.rows[0]!["large"]).toBe(9_223_372_036_854_775_807n);
      expect(result.rows[0]!["exact"]).toBe(exact);
      expect(result.rows[0]!["bytes"]).toEqual(new Uint8Array([0, 255]));
      expect(result.rows[0]!["unicode"]).toBe("España ☃");
      expect(result.rows[0]!["date"]).toContain("2026-01-01");
      expect(result.rows[0]!["date"]).toContain("01:02:03.123");
      expect(result.rows[0]!["nullable"]).toBeNull();
      expect((await db.execute("SELECT CAST(@p1 AS NVARCHAR(80)) AS dateText", ["2026-01-01T01:02:03.123Z"])).rows[0]!["dateText"]).toBe("2026-01-01T01:02:03.123Z");
      const migration = sqlMigration("001-users", [`CREATE TABLE ${table} (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(120) NOT NULL, age INT NOT NULL, note NVARCHAR(120), version INT NOT NULL)`]);
      const first = new SqlMigrator(db, [migration], { tableName: migrationTable });
      const second = new SqlMigrator(db, [migration], { tableName: migrationTable });
      const applied = await Promise.all([first.migrate(), second.migrate()]);
      expect(applied.flat()).toEqual(["001-users"]);
      expect(await first.migrate()).toEqual([]);
      expect((await first.migrationStatus())[0]?.state).toBe("applied");
      const insertSql = `INSERT INTO ${table} (name, age, note, version) VALUES (@p1, 1, NULL, 1)`;
      await db.transaction(async tx => {
        expect((await tx.execute(insertSql, ["committed"])).affectedRows).toBe(1);
        const error = await rejected(tx.transaction(async nested => { await nested.execute(insertSql, ["nested_rollback"]); throw new Error("nested_abort"); }));
        expect(error.message).toBe("nested_abort");
      }, { isolation: "serializable" });
      expect((await rejected(db.transaction(async tx => { await tx.execute(insertSql, ["outer_rollback"]); throw new Error("outer_abort"); }))).message).toBe("outer_abort");
      expect((await db.execute(`SELECT name FROM ${table}`)).rows).toEqual([{ name: "committed" }]);
      interface User { id: number; name: string; age: number; note: string | null; version: number; }
      const entity = defineEntity<User>({ table, columns: { id: { primaryKey: true, generated: true }, name: {}, age: {}, note: {}, version: { version: true } } });
      const repo = new Repository(db, entity);
      const alice = await repo.insert({ name: "Alice", age: 21, note: null });
      await repo.insert({ name: "Bob", age: 40, note: "hello" });
      expect(typeof alice.id).toBe("number");
      expect(alice.version).toBe(1);
      expect(await repo.query().where(u => u.age.gte(20)).orderBy(u => u.age).select(u => ({ name: u.name, next: u.age.plus(1) })).toList()).toEqual([{ name: "Alice", next: 22 }, { name: "Bob", next: 41 }]);
      expect(await repo.query().where(u => u.name.eq("'; DROP TABLE users; --")).count()).toBe(0);
      const stale = await repo.find({ id: alice.id });
      alice.name = "Changed"; await repo.update(alice);
      expect(alice.version).toBe(2);
      stale!.name = "Stale";
      expect(await rejected(repo.update(stale!))).toBeInstanceOf(OptimisticLockError);
      await OrmSession.transaction(db, async session => {
        const current = await session.find(entity, { id: alice.id });
        current!.age = 22;
        expect(await session.find(entity, { id: alice.id })).toBe(current);
        expect(await session.flush()).toEqual({ inserted: 0, updated: 1, deleted: 0 });
      });
      expect((await repo.find({ id: alice.id }))?.age).toBe(22);
      expect((await repo.find({ id: alice.id }))?.version).toBe(3);
      await repo.delete((await repo.find({ id: alice.id }))!);
      expect(await repo.find({ id: alice.id })).toBeNull();
    } finally {
      try { await db.execute(`IF OBJECT_ID('${table}', 'U') IS NOT NULL DROP TABLE ${table}`); await db.execute(`IF OBJECT_ID('${migrationTable}', 'U') IS NOT NULL DROP TABLE ${migrationTable}`); }
      finally { await db.close(); }
    }
  }, 60_000);
});

describe.skipIf(!oracleConnection)("real Oracle original ODBC transport", () => {
  test("exact values, output binds, rollback/savepoints, concurrent DDL locks and generated ORM keys", async () => {
    const db = database("oracle", oracleConnection!);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const table = `bolt_oracle_u_${suffix}`;
    const ledger = `bolt_oracle_m_${suffix}`;
    const quoted = `"${table}"`;
    // Oracle serializable transactions cannot materialize deferred segments.
    const migration = sqlMigration("001-users", [`CREATE TABLE ${quoted} ("id" NUMBER(38,0) GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "name" NVARCHAR2(120) NOT NULL, "age" NUMBER(10,0) NOT NULL, "note" NVARCHAR2(120), "version" NUMBER(10,0) NOT NULL) SEGMENT CREATION IMMEDIATE`], { transactional: false });
    await db.start();
    try {
      const exact = "12345678901234567890123456789012345678";
      const result = await db.execute('SELECT :p1 AS "name", CAST(:p2 AS NUMBER(38,0)) AS "exact", CAST(:p3 AS RAW(4)) AS "bytes", CAST(:p4 AS VARCHAR2(20)) AS "nullable", CAST(:p5 AS TIMESTAMP(3)) AS "date" FROM dual', ["España ☃", exact, new Uint8Array([0, 255]), null, new Date("2026-01-01T01:02:03.123Z")]);
      expect(result.rows[0]!["name"]).toBe("España ☃");
      expect(result.rows[0]!["exact"]).toBe(exact);
      expect(result.rows[0]!["bytes"]).toEqual(new Uint8Array([0, 255]));
      expect(result.rows[0]!["nullable"]).toBeNull();
      expect(result.rows[0]!["date"]).toContain("01:02:03.123");
      const outputs = await db.executeWithOutput('BEGIN :p2 := :p1; END;', [exact], [{ type: "decimal", size: 128 }]);
      expect(outputs.output).toEqual([exact]);
      // The native driver silently rounds unconstrained NUMBER, including when
      // GetString is requested. Fail closed for large and small values alike.
      for (const value of [exact, "1.25"]) {
        const failure = await rejected(db.execute('SELECT CAST(:p1 AS NUMBER) AS "ambiguous" FROM dual', [value]));
        expect(failure).toBeInstanceOf(OdbcError);
        expect((failure as OdbcError).code).toBe("unsupported_numeric_precision");
      }
      expect((await db.execute('SELECT TO_CHAR(CAST(:p1 AS NUMBER)) AS "exact" FROM dual', [exact])).rows[0]!["exact"]).toBe(exact);
      const typedOutputs = await db.executeWithOutput(`BEGIN :p1 := HEXTORAW('00FF'); :p2 := 1.25; :p3 := TO_TIMESTAMP('1999-01-01T01:02:03.123456789', 'YYYY-MM-DD"T"HH24:MI:SS.FF9'); :p4 := NULL; :p5 := TO_TIMESTAMP_TZ('1999-01-01T01:02:03.123456789 -04:00', 'YYYY-MM-DD"T"HH24:MI:SS.FF9 TZH:TZM'); END;`, [], [{ type: "binary", size: 16 }, { type: "number" }, { type: "date", size: 128 }, { type: "decimal", size: 128 }, { type: "date", size: 128 }]);
      expect(typedOutputs.output).toEqual([new Uint8Array([0, 255]), 1.25, "1999-01-01T01:02:03.123456789", null, "1999-01-01T01:02:03.123456789 -04:00"]);
      const first = new SqlMigrator(db, [migration], { tableName: ledger });
      const second = new SqlMigrator(db, [migration], { tableName: ledger });
      expect((await Promise.all([first.migrate(), second.migrate()])).flat()).toEqual(["001-users"]);
      expect(await first.migrate()).toEqual([]);
      expect((await first.migrationStatus())[0]?.state).toBe("applied");
      const insert = `INSERT INTO ${quoted} ("name", "age", "note", "version") VALUES (:p1, 1, NULL, 1)`;
      await db.transaction(async tx => {
        expect((await tx.execute(insert, ["committed"])).affectedRows).toBe(1);
        expect((await rejected(tx.transaction(async nested => { await nested.execute(insert, ["nested_rollback"]); throw new Error("nested_abort"); }))).message).toBe("nested_abort");
      }, { isolation: "serializable" });
      expect((await rejected(db.transaction(async tx => { await tx.execute(insert, ["outer_rollback"]); throw new Error("outer_abort"); }))).message).toBe("outer_abort");
      expect((await db.execute(`SELECT "name" FROM ${quoted}`)).rows).toEqual([{ name: "committed" }]);
      interface User { id: number; name: string; age: number; note: string | null; version: number; }
      const entity = defineEntity<User>({ table, columns: { id: { primaryKey: true, generated: true, ...codecs.integer }, name: {}, age: codecs.integer, note: {}, version: { version: true } } });
      const repo = new Repository(db, entity);
      const alice = await repo.insert({ name: "Alice", age: 21, note: null });
      await repo.insert({ name: "Bob", age: 40, note: "hello" });
      expect(typeof alice.id).toBe("number");
      expect(alice.version).toBe(1);
      expect(await repo.query().where(u => u.age.gte(20)).orderBy(u => u.age).select(u => ({ name: u.name, age: u.age })).toList()).toEqual([{ name: "Alice", age: 21 }, { name: "Bob", age: 40 }]);
      expect(await repo.query().where(u => u.name.eq("'; DROP TABLE users; --")).count()).toBe(0);
      const stale = await repo.find({ id: alice.id });
      alice.name = "Changed"; await repo.update(alice);
      expect(alice.version).toBe(2);
      stale!.name = "Stale";
      expect(await rejected(repo.update(stale!))).toBeInstanceOf(OptimisticLockError);
      await OrmSession.transaction(db, async session => {
        const managed = await session.find(entity, { id: alice.id });
        managed!.age = 22;
        expect(await session.find(entity, { id: alice.id })).toBe(managed);
        expect(await session.flush()).toEqual({ inserted: 0, updated: 1, deleted: 0 });
      });
      expect((await repo.find({ id: alice.id }))?.age).toBe(22);
      await repo.delete((await repo.find({ id: alice.id }))!);
      expect(await repo.find({ id: alice.id })).toBeNull();
    } finally {
      try {
        await db.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${quoted} PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`);
        await db.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${ledger}" PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`);
      } finally { await db.close(); }
    }
  }, 90_000);
});

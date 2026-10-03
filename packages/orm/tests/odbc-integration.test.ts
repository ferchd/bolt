import { describe, expect, test } from "bun:test";
import { SqlDatabase } from "@bolt/database";
import { OdbcTransport } from "../../database-odbc/src/index.ts";
import { and, not, value, avg, count, sum, codecs, defineEntity, OptimisticLockError, OrmSession, Repository } from "../src/index.ts";

const sqlServerConnection = process.env["BOLT_TEST_SQLSERVER_ODBC_CONNECTION"];
const oracleConnection = process.env["BOLT_TEST_ORACLE_ODBC_CONNECTION"];
function database(dialect: "mssql" | "oracle", connectionString: string): SqlDatabase {
  return SqlDatabase.create({ dialect, transport: new OdbcTransport({ dialect, connectionString, powershellExecutable: process.env["BOLT_TEST_ODBC_POWERSHELL"], maxConnections: 2 }) });
}
async function rejected(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected a rejection");
}

describe.skipIf(!sqlServerConnection)("real SQL Server ORM with triggers", () => {
  test("OUTPUT INTO captures exact composite generated keys, reads post-trigger values, updates, deletes and rollback", async () => {
    const db = database("mssql", sqlServerConnection!);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const table = `orm_trigger_${suffix}`;
    const audit = `orm_audit_${suffix}`;
    const insertTrigger = `orm_insert_${suffix}`;
    const updateTrigger = `orm_update_${suffix}`;
    interface Item { tenant: string; id: bigint; name: string; amount: string; note: string | null; enabled: boolean; created: Date; version: number; }
    const items = defineEntity<Item>({ table, columns: { tenant: { primaryKey: true }, id: { primaryKey: true, generated: true, ...codecs.bigint }, name: {}, amount: codecs.decimal, note: {}, enabled: codecs.boolean, created: codecs.date, version: { version: true } } });
    await db.start();
    try {
      await db.execute(`CREATE TABLE ${table} (tenant NVARCHAR(40) NOT NULL, id BIGINT IDENTITY(9007199254740993,7) NOT NULL, name NVARCHAR(120) NOT NULL, amount DECIMAL(38,6) NOT NULL, note NVARCHAR(120), enabled BIT NOT NULL, created DATETIME2(3) NOT NULL, version INT NOT NULL, PRIMARY KEY(tenant,id))`);
      await db.execute(`CREATE TABLE ${audit} (id INT IDENTITY(1200,1) PRIMARY KEY, entity_id BIGINT NOT NULL)`);
      await db.execute(`CREATE TRIGGER ${insertTrigger} ON ${table} AFTER INSERT AS BEGIN INSERT INTO ${audit}(entity_id) SELECT id FROM inserted; UPDATE t SET name=UPPER(t.name), note=NULL, version=t.version+2, amount=t.amount+CAST(0.000001 AS DECIMAL(38,6)) FROM ${table} AS t INNER JOIN inserted AS i ON i.id=t.id AND i.tenant=t.tenant; END`);
      const repo = new Repository(db, items);
      const created = new Date("2026-10-03T12:34:56.789Z");
      const amount = "123456789012345678901234567890.123456";
      const item = await repo.insert({ tenant: "España ☃", name: "before", amount, note: "becomes null", enabled: true, created });
      expect(item.id).toBe(9_007_199_254_740_993n);
      expect(item.name).toBe("BEFORE");
      expect(item.amount).toBe("123456789012345678901234567890.123457");
      expect(item.note).toBeNull();
      expect(item.enabled).toBe(true);
      expect(item.created.toISOString()).toBe(created.toISOString());
      expect(item.version).toBe(3);
      expect(await repo.query().select(u => ({ version: u.version.plus(0), changed: u.version.gte(3), unknown: u.note.eq("x") })).single()).toEqual({ version: 3, changed: true, unknown: null });
      expect(await repo.query().where(u => u.enabled).count()).toBe(1);
      expect(await repo.query().where(() => value(false)).count()).toBe(0);
      expect(await repo.query().where(u => and(u.enabled, not(value(false)))).count()).toBe(1);
      expect(await repo.query().leftJoin(items, () => value(false)).where(({ right }) => right.enabled).count()).toBe(0);
      expect(await repo.query().select(() => ({ flag: value(false) })).single()).toEqual({ flag: false });
      expect((await db.execute(`SELECT id FROM ${audit}`)).rows[0]!["id"]).toBe(1200);
      await db.execute(`CREATE TRIGGER ${updateTrigger} ON ${table} AFTER UPDATE AS BEGIN UPDATE t SET name=UPPER(t.name), version=t.version+10 FROM ${table} AS t INNER JOIN inserted AS i ON i.id=t.id AND i.tenant=t.tenant; END`);
      const stale = await repo.find({ tenant: item.tenant, id: item.id });
      item.name = "updated";
      await repo.update(item);
      expect(item.name).toBe("UPDATED");
      expect(item.version).toBe(14);
      stale!.name = "stale";
      expect(await rejected(repo.update(stale!))).toBeInstanceOf(OptimisticLockError);
      const session = new OrmSession(db);
      const tracked = await session.find(items, { tenant: item.tenant, id: item.id });
      tracked!.name = "session";
      expect(await session.flush()).toEqual({ inserted: 0, updated: 1, deleted: 0 });
      expect(tracked!.name).toBe("SESSION");
      expect(tracked!.version).toBe(25);
      expect(await session.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
      session.dispose();
      const pending: Partial<Item> = { tenant: "España ☃", name: "rollback", amount, note: null, enabled: false, created };
      const aborted = await rejected(OrmSession.transaction(db, async scoped => {
        scoped.add(items, pending);
        await scoped.flush();
        expect(typeof pending.id).toBe("bigint");
        expect(pending.name).toBe("ROLLBACK");
        throw new Error("abort outer transaction");
      }));
      expect(aborted.message).toContain("abort outer transaction");
      expect(pending.id).toBeUndefined();
      expect(pending.version).toBeUndefined();
      expect(pending.name).toBe("rollback");
      expect(await repo.query().count()).toBe(1);
      await repo.delete((await repo.find({ tenant: item.tenant, id: item.id }))!);
      expect(await repo.find({ tenant: item.tenant, id: item.id })).toBeNull();
    } finally {
      try { await db.execute(`DROP TABLE IF EXISTS ${table}; DROP TABLE IF EXISTS ${audit}`); } finally { await db.close(); }
    }
  }, 60_000);

  test("database-generated GUID keys and assigned composite keys work with triggers", async () => {
    const db = database("mssql", sqlServerConnection!);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const table = `orm_guid_${suffix}`;
    interface Item { id: string; name: string; version: number; }
    const items = defineEntity<Item>({ table, columns: { id: { primaryKey: true, generated: true }, name: {}, version: { version: true } } });
    await db.start();
    try {
      await db.execute(`CREATE TABLE ${table} (id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY, name NVARCHAR(80) NOT NULL, version INT NOT NULL)`);
      await db.execute(`CREATE TRIGGER orm_guid_insert_${suffix} ON ${table} AFTER INSERT AS BEGIN SET NOCOUNT ON; UPDATE t SET name=UPPER(t.name) FROM ${table} AS t INNER JOIN inserted AS i ON i.id=t.id; END`);
      const repo = new Repository(db, items);
      const generated = await repo.insert({ name: "generated" });
      expect(generated.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(generated.name).toBe("GENERATED");
      const assigned = crypto.randomUUID();
      expect((await repo.insert({ id: assigned, name: "assigned", version: 2 })).id.toLowerCase()).toBe(assigned);
      expect(await repo.query().select(u => ({ total: count(), average: avg(u.version), sum: sum(u.version) })).single()).toEqual({ total: 2, average: 1.5, sum: 3 });
      await repo.delete(generated);
    } finally { try { await db.execute(`DROP TABLE IF EXISTS ${table}`); } finally { await db.close(); } }
  }, 60_000);
});

describe.skipIf(!oracleConnection)("real Oracle ORM generated keys", () => {
  test("identity-only inserts return every exact numeric and string generated key component", async () => {
    const db = database("oracle", oracleConnection!);
    const table = `orm_oracle_keys_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    interface Key { id: bigint; token: string; }
    const keys = defineEntity<Key>({ table, columns: {
      id: { primaryKey: true, generated: true, ...codecs.bigint },
      token: { primaryKey: true, generated: true, generatedOutput: { type: "string", size: 64 } },
    } });
    await db.start();
    try {
      await db.execute(`CREATE TABLE "${table}" ("id" NUMBER(38,0) DEFAULT 12345678901234567890123456789012345678 NOT NULL, "token" VARCHAR2(32) DEFAULT RAWTOHEX(SYS_GUID()) NOT NULL, PRIMARY KEY("id","token"))`);
      const repository = new Repository(db, keys);
      const first = await repository.insert({});
      const second = await repository.insert({});
      expect(first.id).toBe(12_345_678_901_234_567_890_123_456_789_012_345_678n);
      expect(first.token).toMatch(/^[0-9A-F]{32}$/);
      expect(second.token).not.toBe(first.token);
      expect(await repository.find(first)).toEqual(first);
      await repository.delete(first);
      expect(await repository.query().count()).toBe(1);
    } finally { try { await db.execute(`DROP TABLE "${table}" PURGE`); } finally { await db.close(); } }
  }, 60_000);

  test("RETURNING outputs preserve large numeric identity and BEFORE-trigger values with composite keys and rollback", async () => {
    const db = database("oracle", oracleConnection!);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const table = `orm_oracle_${suffix}`;
    const trigger = `orm_oracle_t_${suffix}`;
    interface Item { tenant: string; id: bigint; name: string; enabled: boolean; note: string | null; version: number; }
    const items = defineEntity<Item>({ table, columns: { tenant: { primaryKey: true }, id: { primaryKey: true, generated: true, ...codecs.bigint }, name: {}, enabled: codecs.boolean, note: {}, version: { version: true } } });
    await db.start();
    try {
      await db.execute(`CREATE TABLE "${table}" ("tenant" VARCHAR2(40) NOT NULL, "id" NUMBER(38,0) GENERATED BY DEFAULT AS IDENTITY (START WITH 9007199254740993), "name" VARCHAR2(120) NOT NULL, "enabled" NUMBER(1) NOT NULL, "note" VARCHAR2(120), "version" NUMBER(10) NOT NULL, PRIMARY KEY("tenant","id"))`);
      await db.execute(`CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW BEGIN :NEW."name" := UPPER(:NEW."name"); :NEW."version" := :NEW."version" + 2; END;`);
      const repo = new Repository(db, items);
      const item = await repo.insert({ tenant: "a", name: "before", enabled: true, note: null });
      expect(item.id).toBe(9_007_199_254_740_993n);
      expect(item.name).toBe("BEFORE");
      expect(item.enabled).toBe(true);
      expect(item.note).toBeNull();
      expect(item.version).toBe(3);
      expect(await repo.query().select(u => ({ version: u.version.plus(0), changed: u.version.gte(3), unknown: u.note.eq("x") })).single()).toEqual({ version: 3, changed: true, unknown: null });
      expect(await repo.query().where(u => u.enabled).count()).toBe(1);
      expect(await repo.query().where(() => value(false)).count()).toBe(0);
      expect(await repo.query().where(u => and(u.enabled, not(value(false)))).count()).toBe(1);
      expect(await repo.query().leftJoin(items, () => value(false)).where(({ right }) => right.enabled).count()).toBe(0);
      expect(await repo.query().select(() => ({ flag: value(false) })).single()).toEqual({ flag: false });
      const stale = { ...item };
      item.name = "after";
      await repo.update(item);
      expect(item.name).toBe("AFTER");
      expect(item.version).toBe(6);
      stale.name = "stale";
      expect(await rejected(repo.update(stale))).toBeInstanceOf(OptimisticLockError);
      const pending: Partial<Item> = { tenant: "a", name: "rollback", enabled: false, note: null };
      const aborted = await rejected(OrmSession.transaction(db, async session => {
        session.add(items, pending); await session.flush();
        expect(typeof pending.id).toBe("bigint");
        throw new Error("rollback Oracle outer");
      }));
      expect(aborted.message).toContain("rollback Oracle outer");
      expect(pending.id).toBeUndefined();
      expect(pending.version).toBeUndefined();
      expect(pending.name).toBe("rollback");
      expect(await repo.query().count()).toBe(1);
      await repo.delete(item);
      expect(await repo.find({ tenant: item.tenant, id: item.id })).toBeNull();
    } finally { try { await db.execute(`DROP TABLE "${table}" PURGE`); } finally { await db.close(); } }
  }, 60_000);
});

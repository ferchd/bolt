import { expect, test } from "bun:test";
import { SqlDatabase, SqlPostCommitError, type SqlExecutor } from "@bolt/database";
import { codecs, defineEntity, OrmPostCommitError, OrmReconciliationError, OrmSession, Repository } from "../src/index.ts";

interface User { id: number; name: string; version: number; }
const users = defineEntity<User>({ table: "users", columns: { id: { primaryKey: true, generated: true }, name: {}, version: { version: true } } });
async function fixture(callback: (database: SqlDatabase) => Promise<void>): Promise<void> {
  const database = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" }); await database.start();
  try { await database.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)"); await callback(database); }
  finally { await database.close(); }
}
async function rejected(promise: Promise<unknown>): Promise<Error> { try { await promise; } catch (error) { if (error instanceof Error) return error; throw error; } throw new Error("Expected rejection"); }

test("queued repository deletes retain the requested identity and version", async () => fixture(async database => {
  const repository = new Repository(database, users);
  const first = await repository.insert({ name: "first" });
  const second = await repository.insert({ name: "second" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed: SqlExecutor = {
    dialect: database.dialect,
    execute: (sql, parameters) => database.execute(sql, parameters),
    transaction: async (callback, options) => { await gate; return database.transaction(callback, options); },
  };
  const deleting = new Repository(delayed, users).delete(first);
  first.id = second.id;
  release(); await deleting;
  expect(await repository.query().toList()).toEqual([second]);
}));

test("post-trigger persisted values are hydrated and snapshots cannot cause a second dirty write", async () => fixture(async database => {
  await database.execute("CREATE TRIGGER users_insert AFTER INSERT ON users BEGIN UPDATE users SET name=UPPER(name), version=version+2 WHERE id=NEW.id; END");
  await database.execute("CREATE TRIGGER users_update AFTER UPDATE ON users WHEN NEW.name != UPPER(NEW.name) BEGIN UPDATE users SET name=UPPER(name), version=version+4 WHERE id=NEW.id; END");
  const session = new OrmSession(database);
  const pending: Partial<User> = { name: "before" };
  session.add(users, pending);
  await session.flush();
  expect(pending.name).toBe("BEFORE"); expect(pending.version).toBe(3);
  expect(await session.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  pending.name = "after";
  await session.flush();
  expect(pending.name).toBe("AFTER"); expect(pending.version).toBe(8);
  expect(await session.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  session.dispose();
}));

test("a codec failure computing a post-trigger snapshot rolls back before COMMIT", async () => fixture(async database => {
  const strict = defineEntity<User>({ table: "users", columns: {
    id: { primaryKey: true, generated: true }, version: { version: true },
    name: { encode: input => { if (input === "TRIGGERED") throw new Error("Post-trigger codec rejects value"); return input; }, decode: input => String(input) },
  } });
  await database.execute("CREATE TRIGGER users_insert AFTER INSERT ON users BEGIN UPDATE users SET name='TRIGGERED' WHERE id=NEW.id; END");
  const pending: Partial<User> = { name: "before" };
  const session = new OrmSession(database); session.add(strict, pending);
  expect((await rejected(session.flush())).message).toContain("Post-trigger codec");
  expect(await new Repository(database, users).query().count()).toBe(0);
  expect(pending).toEqual({ name: "before" });
  session.dispose();
}));

test("read-only entities and proxies are rejected before SQL writes", async () => fixture(async database => {
  for (const pending of [Object.freeze({ name: "frozen" }), new Proxy({ name: "proxy" }, {})]) {
    const session = new OrmSession(database); session.add(users, pending);
    expect(await rejected(session.flush())).toBeInstanceOf(TypeError);
    expect(await new Repository(database, users).query().count()).toBe(0);
    session.dispose();
  }
}));

test("a late freeze reports committed reconciliation failure and invalidates the session", async () => fixture(async database => {
  const pending: Partial<User> = { name: "committed" };
  const lateFreeze: SqlExecutor = {
    dialect: database.dialect,
    execute: (sql, parameters) => database.execute(sql, parameters),
    transaction: async callback => { const result = await database.transaction(callback); Object.freeze(pending); return result; },
  };
  const session = new OrmSession(lateFreeze); session.add(users, pending);
  const failure = await rejected(session.flush());
  expect(failure).toBeInstanceOf(OrmReconciliationError);
  expect((failure as OrmReconciliationError).committed).toBe(true);
  expect(await new Repository(database, users).query().count()).toBe(1);
  expect(pending.id).toBeUndefined();
  expect((await rejected(session.flush())).message).toContain("disposed");
}));

test("outer rollback restores trigger hydration and managed values while retaining newer local edits", async () => fixture(async database => {
  await database.execute("CREATE TRIGGER users_insert AFTER INSERT ON users BEGIN UPDATE users SET name=UPPER(name),version=version+2 WHERE id=NEW.id; END");
  const pending: Partial<User> = { name: "before" };
  const failure = await rejected(OrmSession.transaction(database, async session => {
    session.add(users, pending); await session.flush();
    expect(pending.name).toBe("BEFORE");
    pending.name = "newer local edit";
    throw new Error("abort caller");
  }));
  expect(failure.message).toContain("abort caller");
  expect(pending.id).toBeUndefined(); expect(pending.version).toBeUndefined();
  expect(pending.name).toBe("newer local edit");
  expect(await new Repository(database, users).query().count()).toBe(0);
}));

test("exact codecs reject unsafe numeric coercion and nullable codecs preserve SQL null", () => {
  expect(codecs.integer.decode("42")).toBe(42);
  expect(() => codecs.integer.decode("9007199254740993")).toThrow("safe integer");
  expect(codecs.bigint.decode("12345678901234567890123456789012345678")).toBe(12_345_678_901_234_567_890_123_456_789_012_345_678n);
  expect(codecs.bigint.encode(9_007_199_254_740_993n)).toBe("9007199254740993");
  expect(codecs.decimal.decode("12345678901234567890.123456")).toBe("12345678901234567890.123456");
  expect(() => codecs.decimal.decode(123.4)).toThrow("decimal text");
  expect(codecs.nullable(codecs.boolean).decode(null)).toBeNull();
  expect(codecs.nullable(codecs.boolean).decode("1")).toBe(true);
  expect(codecs.nullable(codecs.date).encode(null)).toBeNull();
  expect(codecs.date.decode("2026-10-03 12:34:56.789").toISOString()).toBe("2026-10-03T12:34:56.789Z");
});

function failedCleanup(database: SqlDatabase): SqlExecutor {
  let fail = true;
  return { dialect: database.dialect, execute: (sql, parameters) => database.execute(sql, parameters), transaction: async callback => {
    const result = await database.transaction(callback);
    if (fail) { fail = false; throw new SqlPostCommitError(new Error("Connection cleanup failed after COMMIT")); }
    return result;
  } };
}

test("confirmed COMMIT plus cleanup failure reconciles the UoW before reporting the error", async () => fixture(async database => {
  const pending: Partial<User> = { name: "committed" };
  const session = new OrmSession(failedCleanup(database)); session.add(users, pending);
  const error = await rejected(session.flush());
  expect(error).toBeInstanceOf(SqlPostCommitError);
  expect(pending.id).toBe(1); expect(pending.version).toBe(1);
  expect(await session.find(users, { id: 1 })).toBe(pending as User);
  expect(await session.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  expect(await new Repository(database, users).query().count()).toBe(1);
  session.dispose();
}));

test("outer transaction cleanup failure does not restore already committed generated identities", async () => fixture(async database => {
  const pending: Partial<User> = { name: "committed" };
  const failure = await rejected(OrmSession.transaction(failedCleanup(database), async session => { session.add(users, pending); await session.flush(); }));
  expect(failure).toBeInstanceOf(SqlPostCommitError);
  expect(pending.id).toBe(1); expect(pending.version).toBe(1);
  expect((await new Repository(database, users).find({ id: 1 }))?.name).toBe("committed");
}));

test("repository insert exposes committed result and update reconciles its version after cleanup failure", async () => fixture(async database => {
  const insertion = await rejected(new Repository(failedCleanup(database), users).insert({ name: "inserted" }));
  expect(insertion).toBeInstanceOf(OrmPostCommitError);
  const committed = (insertion as OrmPostCommitError<User>).result;
  expect(committed.id).toBe(1); expect(committed.version).toBe(1);
  committed.name = "updated";
  expect(await rejected(new Repository(failedCleanup(database), users).update(committed))).toBeInstanceOf(SqlPostCommitError);
  expect(committed.version).toBe(2);
  expect((await new Repository(database, users).find({ id: 1 }))?.name).toBe("updated");
}));

test("a callback's unrelated post-commit error cannot misclassify this transaction's rollback", async () => fixture(async database => {
  const pending: Partial<User> = { name: "rolled back" };
  const foreignFailure = new SqlPostCommitError(new Error("Another database committed"));
  const failure = await rejected(OrmSession.transaction(database, async session => {
    session.add(users, pending); await session.flush(); throw foreignFailure;
  }));
  expect(failure).toBe(foreignFailure);
  expect(pending.id).toBeUndefined(); expect(pending.version).toBeUndefined();
  expect(await new Repository(database, users).query().count()).toBe(0);
}));

test("outer rollback preserves newer nested JSON edits instead of aliasing its hydration snapshot", async () => fixture(async database => {
  interface Settings { id: number; settings: { theme: string }; version: number; }
  await database.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, version INTEGER NOT NULL)");
  const settings = defineEntity<Settings>({ table: "settings", columns: { id: { primaryKey: true, generated: true }, settings: codecs.json(), version: { version: true } } });
  const pending: Partial<Settings> = { settings: { theme: "dark" } };
  const failure = await rejected(OrmSession.transaction(database, async session => {
    session.add(settings, pending); await session.flush();
    pending.settings!.theme = "light";
    throw new Error("abort local JSON edit");
  }));
  expect(failure.message).toContain("abort local JSON edit");
  expect(pending.id).toBeUndefined(); expect(pending.version).toBeUndefined();
  expect(pending.settings).toEqual({ theme: "light" });
  expect(await new Repository(database, settings).query().count()).toBe(0);
}));

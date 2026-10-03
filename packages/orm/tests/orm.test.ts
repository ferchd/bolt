import { describe, expect, test } from "bun:test";
import { SqlDatabase, type SqlDialect, type SqlExecutor } from "@bolt/database";
import { and, avg, codecs, count, defineEntity, Expr, loadRelation, max, min, not, OptimisticLockError, or, OrmSession, Query, Repository, sum, value } from "../src/index.ts";

interface User { id: number; name: string; age: number; team: string; note: string | null; version: number; }
const users = defineEntity<User>({ table: "orm_users", columns: { id: { primaryKey: true, generated: true }, name: {}, age: {}, team: {}, note: {}, version: { version: true } } });
interface Post { id: number; userId: number; title: string; }
const posts = defineEntity<Post>({ table: "orm_posts", columns: { id: { primaryKey: true }, userId: { name: "user_id" }, title: {} } });

async function fixture(callback: (db: SqlDatabase, repo: Repository<User>) => Promise<void>): Promise<void> {
  const db = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" });
  await db.start();
  try {
    await db.execute("CREATE TABLE orm_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER NOT NULL, team TEXT NOT NULL, note TEXT, version INTEGER NOT NULL)");
    await db.execute("CREATE TABLE orm_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL)");
    const repo = new Repository(db, users);
    for (const data of [{ name: "Alice", age: 21, team: "a", note: null }, { name: "Bob", age: 40, team: "a", note: "x" }, { name: "Carol", age: 32, team: "b", note: null }]) await repo.insert(data);
    await callback(db, repo);
  } finally { await db.close(); }
}

describe("deferred typed SQL queries", () => {
  test("branches are immutable, comparisons and malicious values stay parameterized", async () => fixture(async (_db, repo) => {
    const all = repo.query();
    const adults = all.where(u => and(u.age.gte(30), not(u.name.eq("nobody")))).orderBy(u => u.age, "desc");
    expect(await all.count()).toBe(3);
    expect(await adults.select(u => ({ person: u.name, next: u.age.plus(1) })).toList()).toEqual([{ person: "Bob", next: 41 }, { person: "Carol", next: 33 }]);
    const injection = all.where(u => u.name.eq("' OR 1=1; DROP TABLE orm_users; --"));
    expect(injection.compile().sql).not.toContain("DROP");
    expect(await injection.any()).toBe(false);
    expect(await all.count()).toBe(3);
  }));
  test("null, empty IN and LIKE literal escaping use database semantics", async () => fixture(async (_db, repo) => {
    expect(await repo.query().where(u => u.note.eq(null)).count()).toBe(2);
    expect(await repo.query().where(u => u.note.ne(null)).count()).toBe(1);
    expect(await repo.query().where(u => u.id.in([])).toList()).toEqual([]);
    await repo.insert({ name: "100%_![safe]", age: 18, team: "b", note: null });
    expect(await repo.query().where(u => u.name.contains("%_!")).count()).toBe(1);
    expect(await repo.query().where(u => u.name.startsWith("100%")).count()).toBe(1);
    expect(await repo.query().where(u => or(u.name.endsWith("ice"), u.name.eq("Bob"))).count()).toBe(2);
  }));
  test("predicate projections decode booleans and preserve SQL UNKNOWN", async () => fixture(async (_db, repo) => {
    expect(await repo.query().orderBy(u => u.id).select(u => ({ adult: u.age.gte(30), unknown: u.note.eq("x") })).toList()).toEqual([
      { adult: false, unknown: null }, { adult: true, unknown: true }, { adult: true, unknown: null },
    ]);
    for (const dialect of ["mssql", "oracle"] as const) {
      const compiled = repo.query().select(u => ({ adult: u.age.gte(30) })).compile(dialect);
      expect(compiled.sql).toContain("CASE WHEN");
      expect(compiled.parameters).toEqual([30, 30]);
    }
    const oracleAggregates = repo.query().select(u => ({ total: count(), average: avg(u.age), sum: sum(u.age), next: u.age.plus(1) })).compile("oracle");
    expect(oracleAggregates.sql).toContain("CAST(COUNT(*) AS NUMBER(38,0))");
    expect(oracleAggregates.sql).toContain("AS BINARY_DOUBLE");
  }));
  test("ordering, paging composition, cardinality and count of limited rows", async () => fixture(async (_db, repo) => {
    const query = repo.query().orderBy(u => u.age).thenBy(u => u.id).take(3).skip(1).take(1);
    expect((await query.single())?.name).toBe("Carol");
    expect(await query.count()).toBe(1);
    expect(await repo.query().take(0).first()).toBeNull();
    expect(await repo.query().skip(3).any()).toBe(false);
    await expect(repo.query().single()).rejects.toThrow("more than one");
    await expect(repo.query().where(u => u.age.lt(0)).firstOrThrow()).rejects.toThrow("no rows");
    expect(() => repo.query().take(1).where(u => u.age.gt(0))).toThrow("precede");
    expect(() => repo.query().skip(-1)).toThrow("nonnegative");
  }));
  test("join projection and nullable left joins execute on the server", async () => fixture(async (db, repo) => {
    const postRepo = new Repository(db, posts);
    await postRepo.insert({ id: 1, userId: 1, title: "One" });
    await postRepo.insert({ id: 2, userId: 1, title: "Two" });
    const joined = repo.query().join(posts, (u, p) => u.id.eq(p.userId));
    expect(await joined.select(({ left: u, right: p }) => ({ name: u.name, title: p.title })).toList()).toEqual([{ name: "Alice", title: "One" }, { name: "Alice", title: "Two" }]);
    const left = await repo.query().leftJoin(posts, (u, p) => u.id.eq(p.userId)).where(({ right: p }) => p.id.isNull()).select(({ left: u, right: p }) => ({ name: u.name, title: p.title })).toList();
    expect(left).toEqual([{ name: "Bob", title: null }, { name: "Carol", title: null }]);
  }));
  test("grouping, HAVING and aggregates, with invalid grouping rejected", async () => fixture(async (_db, repo) => {
    const grouped = repo.query().groupBy(u => u.team).having(() => count().gte(2)).select(u => ({ team: u.team, total: count(), age: sum(u.age), mean: avg(u.age), youngest: min(u.age), oldest: max(u.age) })).orderBy(u => u.team);
    expect(await grouped.toList()).toEqual([{ team: "a", total: 2, age: 61, mean: 30.5, youngest: 21, oldest: 40 }]);
    expect(await grouped.count()).toBe(1);
    expect(() => repo.query().groupBy(u => u.team).select(u => ({ name: u.name, total: count() })).compile()).toThrow("must be grouped");
    expect(await repo.query().select(u => ({ team: u.team })).distinct().orderBy(u => u.team).toList()).toEqual([{ team: "a" }, { team: "b" }]);
    const bigintPredicate = new Expr<boolean>({ kind: "binary", operator: ">=", left: count().node, right: value(2n).node });
    expect(await repo.query().groupBy(u => u.team).having(() => bigintPredicate).select(u => ({ team: u.team, total: count() })).toList()).toEqual([{ team: "a", total: 2 }]);
    const aggregate = repo.query().select(u => ({ total: count(), age: sum(u.age) }));
    expect(await aggregate.single()).toEqual({ total: 3, age: 93 });
    expect(await aggregate.take(0).first()).toBeNull();
    expect(await aggregate.skip(1).count()).toBe(0);
  }));
});

describe("repository and unit of work", () => {
  test("mapped composite keys and date, boolean, JSON codecs round-trip", async () => fixture(async (db) => {
    interface Preference { account: string; code: string; enabled: boolean; created: Date; settings: { theme: string }; }
    const preferences = defineEntity<Preference>({ table: "orm_preferences", columns: { account: { primaryKey: true, name: "account_id" }, code: { primaryKey: true }, enabled: codecs.boolean, created: codecs.date, settings: codecs.json() } });
    await db.execute("CREATE TABLE orm_preferences (account_id TEXT, code TEXT, enabled INTEGER, created TEXT, settings TEXT, PRIMARY KEY(account_id, code))");
    const repo = new Repository(db, preferences);
    const created = new Date("2026-10-03T10:00:00Z");
    const saved = await repo.insert({ account: "a", code: "ui", enabled: true, created, settings: { theme: "dark" } });
    expect(saved).toEqual({ account: "a", code: "ui", enabled: true, created, settings: { theme: "dark" } });
    expect(await repo.query().where(p => and(p.enabled.eq(true), p.created.gte(created))).count()).toBe(1);
    expect(await repo.query().select(p => ({ date: p.created, enabled: p.enabled })).toList()).toEqual([{ date: created, enabled: true }]);
    saved.enabled = false;
    await repo.update(saved);
    expect((await repo.find({ account: "a", code: "ui" }))?.enabled).toBe(false);
    await expect(repo.find({ account: "a" })).rejects.toThrow("must be assigned");
    await repo.delete(saved);
    expect(await repo.find({ account: "a", code: "ui" })).toBeNull();
  }));
  test("optimistic locking detects stale updates and deletes", async () => fixture(async (_db, repo) => {
    const current = await repo.find({ id: 1 });
    const stale = await repo.find({ id: 1 });
    current!.name = "Updated";
    await repo.update(current!);
    expect(current!.version).toBe(2);
    stale!.name = "Overwrite";
    await expect(repo.update(stale!)).rejects.toBeInstanceOf(OptimisticLockError);
    await expect(repo.delete(stale!)).rejects.toBeInstanceOf(OptimisticLockError);
    expect((await repo.find({ id: 1 }))?.name).toBe("Updated");
  }));
  test("identity map, dirty flush, generated inserts and disposal without implicit writes", async () => fixture(async (db, repo) => {
    const session = new OrmSession(db);
    const first = await session.find(users, { id: 1 });
    expect((await session.query(users).where(u => u.id.eq(1)).first())).toBe(first);
    first!.name = "Changed";
    expect(await session.find(users, { id: 1 })).toBe(first);
    const added: Partial<User> = { name: "Dave", age: 28, team: "c", note: null };
    session.add(users, added);
    expect(added.id).toBeUndefined();
    expect(await session.flush()).toEqual({ inserted: 1, updated: 1, deleted: 0 });
    expect(first!.version).toBe(2);
    expect(added.id).toBe(4);
    expect((await session.find(users, { id: 4 }))).toBe(added as User);
    expect(await session.flush()).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    session.remove(users, first!);
    await session.flush();
    expect(await repo.find({ id: 1 })).toBeNull();
    const other = await session.find(users, { id: 2 });
    other!.name = "Unflushed";
    const outstanding = session.query(users);
    session.dispose();
    expect((await repo.find({ id: 2 }))?.name).toBe("Bob");
    await expect(outstanding.toList()).rejects.toThrow("disposed");
  }));
  test("an optimistic conflict rolls back the entire flush and preserves local versions", async () => fixture(async (db, repo) => {
    const session = new OrmSession(db);
    const one = await session.find(users, { id: 1 });
    const two = await session.find(users, { id: 2 });
    const concurrent = await repo.find({ id: 2 });
    concurrent!.name = "Concurrent";
    await repo.update(concurrent!);
    one!.name = "Must rollback";
    two!.name = "Stale";
    const pending: Partial<User> = { name: "Pending", age: 25, team: "d", note: null };
    session.add(users, pending);
    await expect(session.flush()).rejects.toBeInstanceOf(OptimisticLockError);
    expect((await repo.find({ id: 1 }))?.name).toBe("Alice");
    expect(one!.version).toBe(1);
    expect(pending.id).toBeUndefined();
    expect(await repo.query().count()).toBe(3);
    session.dispose();
  }));
  test("tracked keys and versions cannot be silently changed", async () => fixture(async (db) => {
    const session = new OrmSession(db);
    const row = await session.find(users, { id: 1 });
    row!.id = 5;
    await expect(session.flush()).rejects.toThrow("primary key");
    row!.id = 1;
    row!.version = 8;
    await expect(session.flush()).rejects.toThrow("managed by the ORM");
    session.dispose();
  }));
  test("explicit relation batches execute one query per batch instead of one per owner", async () => fixture(async (db, repo) => {
    await new Repository(db, posts).insert({ id: 1, userId: 1, title: "One" });
    await new Repository(db, posts).insert({ id: 2, userId: 1, title: "Two" });
    const owners = await repo.query().toList();
    let calls = 0;
    const tracked: SqlExecutor = { dialect: db.dialect, execute: (sql, parameters) => { calls++; return db.execute(sql, parameters); }, transaction: (callback, options) => db.transaction(callback, options) };
    const relation = { source: users, target: posts, keys: [["id", "userId"]] as const };
    const loaded = await loadRelation(tracked, relation, owners);
    expect(calls).toBe(1);
    expect(loaded.get(owners[0]!)?.map(row => row.title)).toEqual(["One", "Two"]);
    expect(loaded.get(owners[1]!)).toEqual([]);
    calls = 0;
    await loadRelation(tracked, relation, owners, { batchSize: 1 });
    expect(calls).toBe(3);
  }));
  test("transaction-bound sessions restore generated keys and versions on outer rollback", async () => fixture(async (db, repo) => {
    const pending: Partial<User> = { name: "Pending", age: 30, team: "c", note: null };
    let tracked: User | null = null;
    await expect(OrmSession.transaction(db, async session => {
      tracked = await session.find(users, { id: 1 });
      tracked!.name = "Local edit";
      session.add(users, pending);
      await session.flush();
      expect(tracked!.version).toBe(2);
      expect(pending.id).toBe(4);
      throw new Error("rollback caller");
    })).rejects.toThrow("rollback caller");
    expect(pending.id).toBeUndefined();
    expect(pending.version).toBeUndefined();
    expect((tracked as User | null)?.version).toBe(1);
    expect((tracked as User | null)?.name).toBe("Local edit");
    expect((await repo.find({ id: 1 }))?.name).toBe("Alice");
    expect(await repo.query().count()).toBe(3);
  }));
  test("session operations and direct object mutation during flush are rejected and roll back", async () => fixture(async (db, repo) => {
    let entered!: () => void;
    let release!: () => void;
    const signal = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    let delayed = false;
    const decorate = (executor: SqlExecutor): SqlExecutor => ({
      dialect: executor.dialect,
      execute: async (sql, parameters) => {
        if (!delayed && sql.startsWith("UPDATE")) { delayed = true; entered(); await wait; }
        return executor.execute(sql, parameters);
      },
      transaction: (callback, options) => executor.transaction(tx => callback(decorate(tx)), options),
    });
    const session = new OrmSession(decorate(db));
    const row = await session.find(users, { id: 1 });
    row!.name = "Before flush";
    const flushing = session.flush();
    await signal;
    expect(() => session.add(users, { name: "Unsupported" })).toThrow("while flushing");
    expect(() => session.remove(users, row!)).toThrow("while flushing");
    expect(() => session.query(users)).toThrow("while flushing");
    row!.name = "Changed while flushing";
    release();
    await expect(flushing).rejects.toThrow("mutated during flush");
    expect(row!.version).toBe(1);
    expect((await repo.find({ id: 1 }))?.name).toBe("Alice");
    session.dispose();
  }));
});

describe("dialect compilation and input validation", () => {
  const dialects: SqlDialect[] = ["sqlite", "postgresql", "mysql", "mariadb", "mssql", "oracle"];
  for (const dialect of dialects) test(`${dialect} placeholders, table aliases, joins and pagination`, () => {
    const executor: SqlExecutor = { dialect, execute: () => { throw new Error("Compilation must remain deferred"); }, transaction: () => { throw new Error("Not used"); } };
    const query = Query.from(executor, users).where(u => u.age.gte(18)).join(posts, (u, p) => u.id.eq(p.userId)).select(({ left: u, right: p }) => ({ name: u.name, title: p.title })).orderBy(({ left: u }) => u.id).skip(5).take(10);
    const compiled = query.compile();
    expect(compiled.parameters).toEqual(dialect === "oracle" || dialect === "mssql" ? [18, 5, 10] : [18, 10, 5]);
    if (dialect === "postgresql") expect(compiled.sql).toContain("$1");
    if (dialect === "mssql") { expect(compiled.sql).toContain("@p1"); expect(compiled.sql).toContain("OFFSET @p2 ROWS FETCH NEXT @p3 ROWS ONLY"); }
    if (dialect === "oracle") { expect(compiled.sql).toContain(":p1"); expect(compiled.sql).toContain('FROM "orm_users" "t0"'); expect(compiled.sql).toContain("OFFSET :p2 ROWS FETCH NEXT :p3 ROWS ONLY"); }
    if (dialect === "mysql" || dialect === "mariadb") expect(compiled.sql).toContain("`orm_users`");
    expect(query.take(0).compile().sql).toContain(dialect === "oracle" || dialect === "mssql" ? "WHERE 1 = 0" : "LIMIT");
  });
  test("identifiers, malformed operators, JavaScript predicates, missing keys and unbound objects are rejected", () => {
    expect(() => defineEntity<{ id: number }>({ table: "users; DROP TABLE users", columns: { id: { primaryKey: true } } })).toThrow("Invalid SQL identifier");
    expect(() => defineEntity<{ id: number }>({ table: "users", columns: { id: {} } })).toThrow("primary key");
    const executor: SqlExecutor = { dialect: "sqlite", execute: () => { throw new Error("Unused"); }, transaction: () => { throw new Error("Unused"); } };
    expect(() => Query.from(executor, users).where(() => true as unknown as Expr<boolean>)).toThrow("Expr");
    const bad = new Expr<boolean>({ kind: "binary", operator: "OR 1=1 --" as "=", left: value(1).node, right: value(1).node });
    expect(() => Query.from(executor, users).where(() => bad).compile()).toThrow("operator");
    expect(() => value({ foo: 1 } as unknown as string)).toThrow("scalar SQL value");
  });
  test("expression snapshots isolate mutable dates, bytes and ASTs; Oracle IN is chunked", () => {
    const date = new Date("2026-10-03T00:00:00Z");
    const literal = value(date);
    date.setFullYear(2000);
    const exposed = literal.node;
    if (exposed.kind === "value" && exposed.value instanceof Date) exposed.value.setFullYear(2001);
    const untouched = literal.node;
    expect(untouched.kind === "value" && (untouched.value as Date).getUTCFullYear()).toBe(2026);
    const bytes = new Uint8Array([1, 2]);
    const binary = value(bytes);
    bytes[0] = 8;
    const captured = binary.node;
    expect(captured.kind === "value" && (captured.value as Uint8Array)[0]).toBe(1);
    const executor: SqlExecutor = { dialect: "oracle", execute: () => { throw new Error("Unused"); }, transaction: () => { throw new Error("Unused"); } };
    const compiled = Query.from(executor, users).where(u => u.id.in(Array.from({ length: 1001 }, (_, i) => i))).compile();
    expect(compiled.sql).toContain(" OR ");
    expect(compiled.parameters).toHaveLength(1001);
  });
});

import { expect, test } from "bun:test";
import type { SqlExecutor } from "@bolt/database";
import { and, defineEntity, type Expr, Query, type SqlExpression } from "../src/index.ts";

interface User { id: number; name: string; age: number; }
const users = defineEntity<User>({ table: "users", columns: { id: { primaryKey: true }, name: {}, age: {} } });
const executor: SqlExecutor = { dialect: "sqlite", execute: () => { throw new Error("Unused"); }, transaction: () => { throw new Error("Unused"); } };
// These assertions are checked by tsc and must remain errors; no unsafe JavaScript operator rewriting.
function typeChecks(): void {
  const query = Query.from(executor, users);
  query.where(u => {
    // @ts-expect-error numbers cannot be compared to strings
    u.age.eq("eighteen");
    // @ts-expect-error unknown entity columns are not accessible
    u.missing.eq(1);
    // @ts-expect-error string-only operation
    u.age.startsWith("1");
    return u.id.gt(0);
  });
  // @ts-expect-error JavaScript booleans are not SQL expressions
  query.where(() => true);
  query.select(u => {
    const id: Expr<number> = u.id;
    // @ts-expect-error field scalar types remain preserved
    const wrong: Expr<string> = u.age;
    void wrong;
    return { id, label: u.name };
  });
  const projected = query.select(u => ({ id: u.id, label: u.name })).toList();
  const expected: Promise<{ id: number; label: string }[]> = projected;
  // @ts-expect-error projection result retains field types
  const wrong: Promise<{ id: string; label: string }[]> = projected;
  void expected; void wrong;
  interface Nullable { id: number; flag: boolean | null; note: string | null; }
  const nullable = defineEntity<Nullable>({ table: "nullable_users", columns: { id: { primaryKey: true }, flag: {}, note: {} } });
  const nullableQuery = Query.from(executor, nullable);
  const nullableProjection = nullableQuery.select(u => {
    const predicate: SqlExpression<boolean | null> = u.note.eq("x");
    // @ts-expect-error nullable SQL comparisons can produce UNKNOWN
    const definitelyBoolean: SqlExpression<boolean> = u.note.eq("x");
    const combined: SqlExpression<boolean | null> = and(u.flag, u.id.gt(0));
    void definitelyBoolean; void combined;
    return { predicate };
  }).toList();
  const nullableExpected: Promise<{ predicate: boolean | null }[]> = nullableProjection;
  // @ts-expect-error nullable projection results cannot be narrowed implicitly
  const nullableWrong: Promise<{ predicate: boolean }[]> = nullableProjection;
  nullableQuery.where(u => u.flag);
  nullableQuery.where(u => u.note.eq("x"));
  void nullableExpected; void nullableWrong;
}
test("typed expression assertions are compiled without executing invalid expressions", () => { expect(typeof typeChecks).toBe("function"); });

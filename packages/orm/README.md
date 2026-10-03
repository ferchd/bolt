# Bolt ORM

An original SQL ORM over `@bolt/database`, with no third-party runtime dependencies. Query callbacks build typed SQL expressions; rows are never filtered in JavaScript. Decorators and rewriting JavaScript function source are unnecessary.

```ts
import { SqlDatabase } from "@bolt/database";
import { and, defineEntity, OrmSession, Repository } from "@bolt/orm";

interface User {
  id: string;
  name: string;
  age: number;
  version: number;
}

const users = defineEntity<User>({
  table: "users",
  columns: {
    id: { primaryKey: true },
    name: {},
    age: {},
    version: { version: true },
  },
});

const db = SqlDatabase.create({ dialect: "sqlite", filename: "app.sqlite" });
await db.start();
// Create the table using reviewed @bolt/database migrations before querying it.
const repository = new Repository(db, users);
const saved = await repository.insert({ id: crypto.randomUUID(), name: "Ana", age: 28 });

const page = await repository.query()
  .where(u => and(u.age.gte(18), u.name.startsWith("A")))
  .orderBy(u => u.name)
  .thenBy(u => u.id)
  .select(u => ({ id: u.id, label: u.name }))
  .skip(0)
  .take(20)
  .toList();

const session = new OrmSession(db);
const user = await session.find(users, { id: saved.id });
user!.name = "Ana María";
await session.flush(); // one transaction; optimistic version becomes 2
session.dispose();    // clears tracking; never implicitly flushes
await db.close();
```

`where`, `select`, `orderBy`, `thenBy`, `distinct`, `join`, `leftJoin`, `groupBy` and `having` return new deferred queries. Terminal operators are `toList`, `first`, `firstOrThrow`, `single`, `singleOrThrow`, `any` and `count`. `count` counts result rows, including any existing grouping, distinctness and pagination. Empty results return `null` from `first` and `single`; `single` rejects multiple rows.

Expressions include `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `isNull`, `isNotNull`, numeric `plus`/`minus`, and string `startsWith`, `endsWith`, `contains`. Compose predicates with `and`, `or`, `not`; use `value` for scalar literals. String helpers escape SQL wildcard characters. Aggregate helpers are `count`, `sum`, `avg`, `min`, `max`. Grouped queries require an explicit projection; non-aggregate projection/order/having columns must be grouped.

Comparisons of nullable fields produce `Expr<boolean | null>` because SQL UNKNOWN is preserved in projections; filters accept those predicates and include only true rows. Logical composition preserves that nullable type. Predicate projections use `CASE` on SQL Server and Oracle and decode to booleans. Direct filters such as `.where(u => u.enabled)`, boolean literals, and nullable boolean fields work with explicit boolean codecs, including joined scopes. Arithmetic projections decode SQL numeric strings to checked JavaScript numbers.

```ts
const names = await repository.query()
  .join(posts, (u, p) => u.id.eq(p.userId))
  .select(({ left: u, right: p }) => ({ user: u.name, title: p.title }))
  .toList();

const related = await loadRelation(db, {
  source: users,
  target: posts,
  keys: [["id", "userId"]],
}, owners);
```

Joins expose nested `{ left, right }` scopes; successive joins nest the preceding scope under `left`. Left-joined right fields carry nullable types. `loadRelation` returns a map from each owner object to its related rows, supports composite key pairs and issues one query per batch (at most 500 bound parameters), rather than hidden lazy queries. Owners with a null relation key have no related rows.

`Column.name` maps properties to physical columns. Declare all primary-key properties for a composite identity. Use explicit `codecs.date`, `codecs.boolean`, `codecs.integer`, `codecs.bigint`, `codecs.decimal`, `codecs.json<T>()`, or custom `encode`/`decode` functions whenever model types differ from returned SQL values. `integer` checks the JavaScript safe-integer range; `bigint` binds exact text and decodes bigint; `decimal` preserves decimal text rather than converting to floating numbers. Compose nullable columns with `codecs.nullable(codec)`. The date codec treats offset-free persisted timestamps as UTC, matching its emitted UTC values. Version columns default to the safe-integer codec. An insert requires every mapped property except absent generated keys and version (which defaults to 1). Server defaults for arbitrary absent columns are not inferred.

`Repository.update`/`delete` check keys and, if configured, the previous numeric version. Stale writers throw `OptimisticLockError`. Updates and inserts hydrate the final persisted values after triggers, including actual managed versions. SQLite/PostgreSQL use returned target keys to distinguish target-row changes from trigger side effects; SQL Server captures keys through `OUTPUT ... INTO`. Unversioned MySQL/MariaDB unchanged updates distinguish an existing row from a missing row within the same transaction. Use `Repository.inTransaction(executor, entity)` only inside an existing transaction callback to avoid redundant CRUD savepoints.

`OrmSession` tracks identity and persisted snapshots per entity metadata object. Repeated reads return the same instance without overwriting local edits. Queue inserts with `add`, deletes with `remove`, or detach existing instances with `detach`; changes to tracked properties are detected at explicit `flush`. Generated keys, trigger hydration and managed versions are published after successful flush; failed flushes roll back all writes and leave managed values unchanged. All codec execution, identity conflicts and replacement snapshots are checked before commit. Publication uses writable data properties without invoking custom setters. Frozen entities, accessor properties and proxies are rejected before SQL. If outside code freezes a tracked object during the commit itself, `OrmReconciliationError` carries `committed: true` and invalidates the session so an insert cannot accidentally be retried. Reload persisted state in a new session. Primary keys and versions cannot be manually changed while tracked. Use one session per request and await its operations; session methods are rejected during flush, and direct property mutation detected before commit rolls back the flush.

If SQL confirms `COMMIT` and connection cleanup subsequently fails, `SqlPostCommitError` has `committed: true`. The session publishes its already prepared state before propagating this error; a subsequent flush does not duplicate the insert. Repository updates likewise reconcile final values; repository inserts expose their committed result through `OrmPostCommitError.result`. Such errors must not be treated as safe retries. Ordinary transaction/callback failures still restore local state on rollback.

Use `await OrmSession.transaction(db, async session => { ...; await session.flush(); })` when additional operations share one outer transaction. It binds queries and flushes to that transaction, disposes the scoped session, and restores ORM-managed keys/versions if the callback or commit fails. The callback must explicitly await flush. If constructing a session directly from an already-bound executor, its flush cannot know when the caller's outer transaction commits; prefer this helper when rollback reconciliation is needed. Direct repository objects updated inside a caller-managed outer transaction also remain the caller's responsibility if that outer transaction subsequently rolls back.

SQL compilation covers SQLite, PostgreSQL, MySQL, MariaDB, SQL Server and Oracle, including provider identifiers, bound parameters, joins, aggregates and pagination. SQLite/PostgreSQL/MariaDB inserts capture primary keys with `RETURNING` before reading final persisted values (MariaDB 10.5+). MySQL returns one `AUTO_INCREMENT` identity per insert and reads the row by its complete key. SQL Server derives a temporary key table from the actual column schema through a zero-row `UNION ALL`, preventing inherited `IDENTITY`, then uses `OUTPUT INSERTED ... INTO` and reads the complete row after triggers. This preserves native GUID, bigint and decimal/composite key types without guessing their SQL types. SQL Server number `AVG`/`SUM` use floating numeric semantics and count uses `COUNT_BIG`; integer averages do not silently truncate.

Oracle generated keys use explicit output bindings through `SqlExecutor.executeWithOutput`, with `RETURNING ... INTO` followed by a read on the same transactional executor. The default generated output is exact decimal text; use `generatedOutput: { type: "string", size: 4000 }` or `type: "binary"` for other key types, and an intentional property codec for the returned model representation. Multiple generated components are supported with providers that return them. For example: `id: { primaryKey: true, generated: true, ...codecs.bigint }` preserves a 38-digit Oracle `NUMBER` without unsafe number coercion. Physical names are quoted exactly, including Oracle case-sensitive names. A dialect compiler does not supply a connection transport; see `@bolt/database` for native transports and the original `@bolt/database-odbc` transport.

An entity's primary keys are its stable identity across triggers. If a trigger changes or removes the returned insert/update identity, or retains/recreates a physically deleted entity, the ORM rejects the operation inside its transaction and rolls it back. It never substitutes an unrelated row or silently marks an existing row as deleted.

Apply filtering, ordering, joins and grouping before pagination; attempting them afterward throws instead of changing LINQ semantics silently. Repeated `take` limits intersect, and subsequent `skip` subtracts from an existing limit. Pagination defaults to primary-key ordering for ordinary entity queries; grouped and distinct pages require explicit order. When supplying your own order, append unique keys with `thenBy` to resolve ties. Arbitrary SQL, correlated subqueries, automatic relationship persistence, implicit lazy loading, expression-source rewriting and automatic schema synchronization are deliberately absent in this version. Schema migrations belong to `@bolt/database`.

Tests run real SQLite CRUD, joins, aggregates, codec mapping, identity tracking, optimistic conflicts, complete flush rollback, outer transaction rollback, codec failure before commit and concurrent mutation handling. TypeScript checks rejected expression types and inferred projection types. Dialect SQL compilation is checked for six engines. Optional real PostgreSQL/MySQL/MariaDB suites use `BOLT_POSTGRESQL_TEST_URL`, `BOLT_MYSQL_TEST_URL`, `BOLT_MARIADB_TEST_URL`; no credentials are hard-coded. `BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL=1` is an explicit local-test-only opt-in for insecure ephemeral MySQL authentication. ODBC engine suites use `BOLT_TEST_SQLSERVER_ODBC_CONNECTION` and `BOLT_TEST_ORACLE_ODBC_CONNECTION`; they exercise triggers, generated/composite identities, precise values, versions and rollback.

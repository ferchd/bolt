# Bolt ODBC transport

Original SQL Server and Oracle transport for `@bolt/database`. No third-party
JavaScript package, NuGet package or experimental Bun FFI is used. The bundled
PowerShell worker calls the platform's `System.Data.Odbc` API and an installed
native database driver. Every reservation pins one physical connection; workers
run as hidden subprocesses and the pool, reservation queue and execution times
are bounded.

```ts
import { SqlDatabase } from "@bolt/database";
import { OdbcTransport } from "@bolt/database-odbc";

const transport = new OdbcTransport({
  dialect: "mssql", // or "oracle"
  connectionString: process.env["DATABASE_ODBC_CONNECTION"]!,
  maxConnections: 4,
  commandTimeoutSeconds: 30,
  operationTimeoutMs: 60_000,
});
const database = SqlDatabase.create({ dialect: "mssql", transport });
await database.start();
try {
  const { rows } = await database.execute(
    "SELECT name FROM customers WHERE id = @p1",
    [42],
  );
  console.log(rows);
} finally {
  await database.close();
}
```

## Platform prerequisites

The default host is **Windows PowerShell 5.1 on Windows**, where .NET Framework
includes ODBC in `System.Data.dll`. An explicit `powershellExecutable` can select
PowerShell 7.5+ (`pwsh`) with `System.Data.Odbc` available. Earlier PowerShell 7
versions are rejected because their JSON reader converts date strings implicitly.
A vendor ODBC driver of
matching process architecture, server access, credentials, TLS configuration and
an optional DSN must be provisioned by the deployment. Bolt installs no driver
and does not bypass the driver's TLS verification. Other operating systems need
an explicitly configured compatible `pwsh`, .NET ODBC facilities and driver;
that configuration has not been verified here.

Use a Microsoft SQL Server driver for `mssql` and an Oracle ODBC driver/client for
`oracle`. Connection strings follow the selected driver's syntax. They are sent
only through the private stdin pipe, never through process arguments or logs.
Provider errors expose SQLSTATE and native numeric codes, excluding provider
text, SQL and credential values. `workerScript` and `powershellExecutable` are
trusted administrator configuration and must never come from request input.
The Oracle worker sets its own `NLS_LANG=AMERICAN_AMERICA.AL32UTF8` before opening
the driver, preserving Unicode through native CHAR conversions and deterministic
numeric text. This does not change the application's or operating system's
environment. See [Oracle's Unicode guidance](https://docs.oracle.com/en/database/oracle/oracle-database/19/nlspg/programming-with-unicode.html).

## Query and transaction behavior

- `@p1` and `:p1` compiler markers become positional ODBC `?` markers. Repeated
  and out-of-order markers duplicate/reorder bound parameters correctly. SQL
  strings, quoted identifiers, Oracle alternative quoting and comments remain
  intact. Direct `?` parameters work; mixing marker styles is rejected.
- Values are `OdbcParameter` instances; their content is never interpolated.
  Integers use integer bindings so SQL Server paging works.
- Transaction control emitted by `SqlDatabase` calls `BeginTransaction`,
  `Commit` and `Rollback`, and each command receives the active
  `OdbcTransaction`. Oracle's `SET TRANSACTION ISOLATION LEVEL` starts the .NET
  transaction, preventing per-statement autocommit. Nested savepoint statements
  use that same connection and transaction.
  Oracle serializable writes require materialized table segments: use
  `SEGMENT CREATION IMMEDIATE` when creating tables that will receive their first
  writes in such a transaction. Oracle's native `ORA-08177` concurrency failure
  is surfaced rather than replaying application callbacks. See
  [Oracle's transaction restrictions](https://docs.oracle.com/en/database/oracle/oracle-database/26/adfns/database-development-guide.pdf).
- Release waits for queued session commands and rolls back outstanding work.
  A timeout, malformed protocol frame or crashed worker disposes the process;
  an unavailable physical connection is replaced for subsequent reservations.
  Shutdown rejects waiters and drains leases with a finite deadline.
- Output parameters use `executeWithOutput(sql, inputs, outputDescriptors)`.
  Output markers follow the input indexes (`:pN`/`@pN`); each output marker must
  occur once. Text, exact decimals, bigint, numbers, binary and temporal outputs
  are supported with explicit sizes. Oracle `RETURNING ... INTO` captures
  generated keys without querying an unrelated sequence or connection.
- Oracle migrations use a session-owned `SYS.DBMS_LOCK` lock allocated with
  `ALLOCATE_UNIQUE_AUTONOMOUS` and `release_on_commit => FALSE`, so DDL's implicit
  commits cannot release it. The migration account needs `EXECUTE` on
  `SYS.DBMS_LOCK`. Missing privileges or output-bind support fail explicitly;
  `SqlMigrationOptions.lock` supports a deployment-specific alternative. Dirty
  migration records and immutable checksums retain their existing safeguards.
- Failed session callbacks discard the ODBC physical connection before release,
  so abandoned session locks cannot leak into later reservations. Database
  cleanup errors after an acknowledged commit expose `SqlPostCommitError` with
  `committed: true`; applications must reconcile these rather than replay writes.
- One rowset is returned. Multiple non-empty rowsets and duplicate column aliases
  are rejected. Results are materialized in memory, bounded by `maxRows` and
  `maxResponseBytes`; this transport does not expose streaming readers.

## Exact values

SQL `BIGINT` becomes JavaScript `bigint`; decimal/numeric values stay exact
strings, including precision beyond .NET's 28-digit decimal limit. Bind high
precision decimals as strings and let the declared SQL column or an explicit
`CAST` convert them. Bigint inputs are limited to signed 64-bit values. Binary
data becomes `Uint8Array`; null, booleans, Unicode and floating values retain
their respective representations. Native date/time results remain driver text
to preserve precision and timezone semantics; JavaScript `Date` input is bound
as a UTC timestamp with its original millisecond precision. Applications must
choose explicit timezone/temporal codecs when converting native timestamps.

## Verification

`bun test ./tests` exercises the actual PowerShell subprocess protocol, a real
missing-DSN failure through `System.Data.Odbc`, session pinning/reset, bound
values, malformed frames, worker crashes, queue limits and finite timeouts.
Native-driver failure tests run on Windows; protocol/codec tests do not require
a live database.

Set `BOLT_TEST_SQLSERVER_ODBC_CONNECTION` to run the database integration test.
It creates randomly named test tables, removes them in `finally`, and verifies
decimal(38), maximum bigint, binary/Unicode/null/date values, identity OUTPUT,
affected rows, rollback/savepoints, concurrent migration locks, LINQ projections,
optimistic conflicts and request-scoped ORM identity/flush behavior. This passed
against SQL Server 2022 CU20 using Windows PowerShell 5.1 and the Windows
SQL Server ODBC driver. The same integration also passed using PowerShell 7.6.5.

`BOLT_TEST_ORACLE_ODBC_CONNECTION` enables the Oracle integration test covering
exact values, output binds, rollback/savepoints, concurrent DDL migration locks,
generated identities and ORM request scopes; an
optional `BOLT_TEST_ODBC_POWERSHELL` selects the executable for both integration
suites. This passed against real Oracle Free 26ai 23.26.3 using Windows PowerShell
5.1 and Oracle Instant Client Basic/ODBC 23.26.3, downloaded from Oracle and
verified against published SHA-256 checksums. Separate ORM integration also
verified simultaneous NUMBER(38)/VARCHAR generated output binds, composite keys,
identities beyond JavaScript's safe integer range, trigger hydration and rollback.
The [native test harness](tests/oracle/README.md) records the sources, checksums,
configuration and isolated cleanup requirements. This test deployment uses a
compatibility container on Ubuntu 22.04; it does not establish
Oracle certification for that operating system. Production deployments should
follow Oracle's supported platform and driver requirements.

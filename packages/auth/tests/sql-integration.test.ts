import { expect, test } from "bun:test";
import { SqlDatabase, SqlMigrator, type SqlDialect } from "@bolt/database";
import { OdbcTransport } from "../../database-odbc/src/index.ts";
import { SqlSessionStore } from "../src/index.ts";

const mysqlTls = Bun.env["BOLT_MYSQL_TEST_TLS"];
if (mysqlTls !== undefined && !["require", "verify-ca", "verify-full"].includes(mysqlTls)) throw new TypeError("BOLT_MYSQL_TEST_TLS must be require, verify-ca or verify-full");

for (const [dialect, environment] of [
  ["postgresql", "BOLT_POSTGRESQL_TEST_URL"], ["mysql", "BOLT_MYSQL_TEST_URL"], ["mariadb", "BOLT_MARIADB_TEST_URL"],
  ["mssql", "BOLT_TEST_SQLSERVER_ODBC_CONNECTION"], ["oracle", "BOLT_TEST_ORACLE_ODBC_CONNECTION"],
] as const) {
  const connection = Bun.env[environment];
  test.skipIf(!connection)(`real ${dialect} authentication ledger and atomic rotation`, async () => {
    const database = ["mssql", "oracle"].includes(dialect)
      ? SqlDatabase.create({ dialect: dialect as SqlDialect, transport: new OdbcTransport({ dialect: dialect as "mssql" | "oracle", connectionString: connection!, powershellExecutable: Bun.env["BOLT_TEST_ODBC_POWERSHELL"] }) })
      : SqlDatabase.create({ dialect, url: connection!, ...(dialect === "mysql" && mysqlTls !== undefined ? { tls: mysqlTls as "require" | "verify-ca" | "verify-full" } : {}), allowPublicKeyRetrieval: Bun.env["BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL"] === "1" });
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const table = `bolt_auth_${suffix}`;
    const ledger = `bolt_auth_m_${suffix}`;
    const quote = (name: string) => dialect === "mysql" || dialect === "mariadb" ? `\`${name}\`` : `"${name}"`;
    await database.start();
    try {
      const store = new SqlSessionStore(database, table);
      await new SqlMigrator(database, [store.migration()], { tableName: ledger }).migrate();
      const first = { tokenHash: "a".repeat(64), userId: "test-user-日本-😀", expiresAt: 20000 };
      await store.create(first);
      expect(await store.find(first.tokenHash, 10000)).toEqual(first);
      const results = await Promise.all(["b", "c"].map(value => store.rotate(first.tokenHash, { ...first, tokenHash: value.repeat(64) }, 10000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.find(first.tokenHash, 10000)).toBeNull();
      const winner = { ...first, tokenHash: (results[0] ? "b" : "c").repeat(64) };
      const occupied = { ...first, tokenHash: "d".repeat(64) };
      await store.create(occupied);
      // Explicit await avoids Bun's Windows async matcher interaction with
      // subprocess-backed ODBC failures; the actual transaction still executes.
      let insertionFailure: unknown;
      try { await store.rotate(winner.tokenHash, occupied, 10000); } catch (error) { insertionFailure = error; }
      expect(insertionFailure).toBeInstanceOf(Error);
      expect(await store.find(winner.tokenHash, 10000)).toEqual(winner);
      expect(await store.find(winner.tokenHash, 20000)).toBeNull();
      expect(await store.rotate(winner.tokenHash, { ...winner, tokenHash: "e".repeat(64) }, 20000)).toBe(false);
      await store.purge(20000);
      expect((await database.execute(`SELECT * FROM ${quote(table)}`)).rows).toHaveLength(0);
      await store.create({ ...first, expiresAt: 30000 });
      await store.revokeUser(first.userId);
      expect((await database.execute(`SELECT * FROM ${quote(table)}`)).rows).toHaveLength(0);
    } finally {
      try { await database.execute(`DROP TABLE ${quote(table)}`); await database.execute(`DROP TABLE ${quote(ledger)}`); } finally { await database.close(); }
    }
  }, 60000);
}

import { describe, expect, test } from "bun:test";
import { SqlDatabase, SqlMigrator, sqlMigration, type SqlDialect } from "../src/index.ts";

const engines: readonly { dialect: SqlDialect; environment: string }[] = [
  { dialect: "postgresql", environment: "BOLT_POSTGRESQL_TEST_URL" },
  { dialect: "mysql", environment: "BOLT_MYSQL_TEST_URL" },
  { dialect: "mariadb", environment: "BOLT_MARIADB_TEST_URL" },
];
for (const { dialect, environment } of engines) {
  const url = Bun.env[environment];
  describe(`real ${dialect} transport`, () => {
    test.skipIf(!url)("prepared parameters, generated IDs, transactions, savepoints and migration locks", async () => {
      const db = SqlDatabase.create({ dialect, url: url!, maxConnections: 3, connectionTimeout: 5, allowPublicKeyRetrieval: Bun.env["BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL"] === "1" });
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const table = `bolt_items_${suffix}`;
      const migrationsTable = `bolt_m_${suffix}`;
      const key = dialect === "postgresql" ? "BIGSERIAL PRIMARY KEY" : "BIGINT AUTO_INCREMENT PRIMARY KEY";
      const marker = dialect === "postgresql" ? "$1" : "?";
      await db.start();
      try {
        const migration = sqlMigration("001-create", [`CREATE TABLE ${table} (id ${key}, name VARCHAR(190) NOT NULL)`], { transactional: dialect === "postgresql" });
        const first = new SqlMigrator(db, [migration], { tableName: migrationsTable });
        const second = new SqlMigrator(db, [migration], { tableName: migrationsTable });
        const runs = await Promise.all([first.migrate(), second.migrate()]);
        expect(runs.map((entries) => entries.length).sort()).toEqual([0, 1]);
        expect((await first.migrationStatus())[0]?.state).toBe("applied");
        const hostile = "Robert'); DROP TABLE users; --";
        const inserted = await db.execute(`INSERT INTO ${table} (name) VALUES (${marker})${dialect === "postgresql" ? " RETURNING id" : ""}`, [hostile]);
        expect(inserted.affectedRows).toBe(1);
        if (dialect === "postgresql") expect(inserted.rows[0]?.["id"]).toBeDefined();
        else expect(inserted.insertId).toBeDefined();
        const selected = await db.execute(`SELECT name FROM ${table} WHERE name = ${marker}`, [hostile]);
        expect(selected.rows).toEqual([{ name: hostile }]);
        expect(selected.affectedRows).toBe(0);
        await expect(db.transaction(async (tx) => {
          await tx.execute(`INSERT INTO ${table} (name) VALUES (${marker})`, ["rolled back"]);
          await Promise.resolve();
          throw new Error("forced rollback");
        })).rejects.toThrow("forced rollback");
        await db.transaction(async (tx) => {
          await tx.execute(`INSERT INTO ${table} (name) VALUES (${marker})`, ["committed"]);
          await expect(tx.transaction(async (nested) => {
            await nested.execute(`INSERT INTO ${table} (name) VALUES (${marker})`, ["savepoint rollback"]);
            throw new Error("savepoint failure");
          })).rejects.toThrow("savepoint failure");
        }, { isolation: "serializable" });
        expect((await db.execute(`SELECT name FROM ${table} ORDER BY id`)).rows).toEqual([{ name: hostile }, { name: "committed" }]);
        expect((await db.execute(`UPDATE ${table} SET name = ${marker} WHERE name = ${dialect === "postgresql" ? "$2" : "?"}`, ["updated", "committed"])).affectedRows).toBe(1);
      } finally {
        try { await db.execute(`DROP TABLE IF EXISTS ${table}`); await db.execute(`DROP TABLE IF EXISTS ${migrationsTable}`); } finally { await db.close(); }
      }
    }, 30000);
    test.skipIf(!url || dialect === "postgresql")("implicit DDL commits leave a dirty record that blocks an unsafe retry", async () => {
      const db = SqlDatabase.create({ dialect, url: url!, allowPublicKeyRetrieval: Bun.env["BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL"] === "1" });
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const table = `bolt_dirty_${suffix}`;
      const migrationsTable = `bolt_m_${suffix}`;
      await db.start();
      try {
        const runner = new SqlMigrator(db, [sqlMigration("001-broken", [`CREATE TABLE ${table} (id INTEGER)`, `INSERT INTO bolt_nonexistent_${suffix} VALUES (1)`], { transactional: false })], { tableName: migrationsTable });
        await expect(runner.migrate()).rejects.toThrow();
        expect((await runner.migrationStatus())[0]?.state).toBe("dirty");
        await expect(runner.migrate()).rejects.toThrow("is dirty");
        expect((await db.execute(`SELECT * FROM ${table}`)).rows).toEqual([]);
      } finally {
        try { await db.execute(`DROP TABLE IF EXISTS ${table}`); await db.execute(`DROP TABLE IF EXISTS ${migrationsTable}`); } finally { await db.close(); }
      }
    }, 30000);
  });
}

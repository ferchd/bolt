import { SqlDatabase, type SqlDialect } from "../packages/database/src/index.ts";

// CI uses isolated official database services. These credentials are test-only.
await Promise.all(([
  ["postgresql", "BOLT_POSTGRESQL_TEST_URL"],
  ["mysql", "BOLT_MYSQL_TEST_URL"],
  ["mariadb", "BOLT_MARIADB_TEST_URL"],
] as const).map(async ([dialect, environment]) => {
  const url = Bun.env[environment];
  if (!url) throw new Error(`Missing integration configuration: ${environment}`);
  const deadline = Date.now() + 90_000;
  while (true) {
    const database = SqlDatabase.create({
      dialect: dialect as SqlDialect,
      url,
      connectionTimeout: 2,
      allowPublicKeyRetrieval: Bun.env["BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL"] === "1",
    });
    try {
      await database.start();
      await database.execute("SELECT 1");
      console.log(`${dialect} integration service is ready`);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`${dialect} integration service did not become ready`);
      await Bun.sleep(1000);
    } finally {
      await database.close();
    }
  }
}));

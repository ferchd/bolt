import { SqlDatabase, type SqlDialect } from "../packages/database/src/index.ts";

// CI uses isolated official database services. These credentials are test-only.
const configured = ([
  ["postgresql", "BOLT_POSTGRESQL_TEST_URL"],
  ["mysql", "BOLT_MYSQL_TEST_URL"],
  ["mariadb", "BOLT_MARIADB_TEST_URL"],
] as const).filter(([, environment]) => Boolean(Bun.env[environment]));
if (!configured.length) throw new Error("At least one integration SQL URL is required");
await Promise.all(configured.map(async ([dialect, environment]) => {
  const url = Bun.env[environment];
  if (!url) throw new Error(`Missing integration configuration: ${environment}`);
  const deadline = Date.now() + 180_000;
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
    } catch (error) {
      if (Date.now() >= deadline) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
        const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : "unknown";
        throw new Error(`${dialect} integration service did not become ready (${safeCode})`);
      }
      await Bun.sleep(1000);
    } finally {
      await database.close();
    }
  }
}));

import { SqlDatabase, type SqlDialect } from "../packages/database/src/index.ts";

// CI uses isolated official database services. These credentials are test-only.
const configured = ([
  ["postgresql", "BOLT_POSTGRESQL_TEST_URL"],
  ["mysql", "BOLT_MYSQL_TEST_URL"],
  ["mariadb", "BOLT_MARIADB_TEST_URL"],
] as const).filter(([, environment]) => Boolean(Bun.env[environment]));
if (!configured.length) throw new Error("At least one integration SQL URL is required");
const mysqlTls = Bun.env["BOLT_MYSQL_TEST_TLS"];
if (mysqlTls !== undefined && !["require", "verify-ca", "verify-full"].includes(mysqlTls)) throw new TypeError("BOLT_MYSQL_TEST_TLS must be require, verify-ca or verify-full");
await Promise.all(configured.map(async ([dialect, environment]) => {
  const url = Bun.env[environment];
  if (!url) throw new Error(`Missing integration configuration: ${environment}`);
  const deadline = Date.now() + 180_000;
  let previousFailure: string | undefined;
  while (true) {
    const database = SqlDatabase.create({
      dialect: dialect as SqlDialect,
      url,
      connectionTimeout: 2,
      ...(dialect === "mysql" && mysqlTls !== undefined ? { tls: mysqlTls as "require" | "verify-ca" | "verify-full" } : {}),
      allowPublicKeyRetrieval: Bun.env["BOLT_MYSQL_TEST_ALLOW_PUBLIC_KEY_RETRIEVAL"] === "1",
    });
    try {
      await database.start();
      await database.execute("SELECT 1");
      console.log(`${dialect} integration service is ready`);
      return;
    } catch (error) {
      const details = sqlFailureDetails(error);
      if (error && typeof error === "object" && "code" in error && error.code === "BOLT_MYSQL_TLS_REQUIRED") throw new Error(`${dialect} integration configuration requires TLS (${details})`);
      if (details !== previousFailure) {
        console.log(`${dialect} integration service is waiting (${details})`);
        previousFailure = details;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${dialect} integration service did not become ready (${details})`);
      }
      await Bun.sleep(1000);
    } finally {
      await database.close();
    }
  }
}));

/** Server error identifiers are diagnostic; messages can contain hosts, users or credentials. */
function sqlFailureDetails(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const details: string[] = [];
  while (pending.length && seen.size < 8) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    const fields: string[] = [];
    if ("code" in candidate && typeof candidate.code === "string" && /^[A-Z0-9_]{1,80}$/.test(candidate.code)) fields.push(`code=${candidate.code}`);
    if ("errno" in candidate && typeof candidate.errno === "number" && Number.isSafeInteger(candidate.errno) && candidate.errno >= 0 && candidate.errno <= 999999) fields.push(`errno=${candidate.errno}`);
    if ("sqlState" in candidate && typeof candidate.sqlState === "string" && /^[A-Z0-9]{5}$/.test(candidate.sqlState)) fields.push(`sqlState=${candidate.sqlState}`);
    if (fields.length) details.push(fields.join(", "));
    if (candidate instanceof AggregateError) pending.push(...candidate.errors.slice(0, 8));
    if ("cause" in candidate) pending.push(candidate.cause);
  }
  return [...new Set(details)].join("; ") || "code=unknown";
}

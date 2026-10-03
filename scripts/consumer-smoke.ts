export function smokeApplication(): string {
  return `import { runCli } from "@bolt/cli";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Environment } from "@bolt/config";
import { createToken, provideValue } from "@bolt/container";
import { Database, SqlDatabase, SqlMigrator, sqlMigration } from "@bolt/database";
import { Gate, SqlSessionStore } from "@bolt/auth";
import { OdbcTransport } from "@bolt/database-odbc";
import { HttpError } from "@bolt/http";
import { BoltApplication } from "@bolt/kernel";
import { Logger } from "@bolt/logger";
import { Router } from "@bolt/router";
import { secureHeaders } from "@bolt/security";
import { defineEntity, Repository, OrmSession } from "@bolt/orm";
import { LocalStorage, StorageManager } from "@bolt/storage";
import { TestClient } from "@bolt/testing";
import v from "@bolt/validation";

const message = createToken<string>("message");
const router = Router.create();

router
  .get("/", (context) => ({ message: context.resolve(message) }))
  .use(secureHeaders());

const application = BoltApplication.create({
  bindings: [provideValue(message, "ready")],
  development: false,
  hostname: "127.0.0.1",
  port: 0,
  router,
  shutdownSignals: false,
});
const client = TestClient.create(application);
const response = await client.get("/");

if (response.status !== 200 || (await response.json()).message !== "ready") {
  throw new Error("Packaged application smoke test failed");
}

const database = Database.create({ filename: ":memory:" });
database.start({ migrate: false });
database.stop();

const odbc = new OdbcTransport({ dialect: "mssql", connectionString: "Driver={test-only};", powershellExecutable: "pwsh" });
const odbcEntry = fileURLToPath(import.meta.resolve("@bolt/database-odbc"));
if (odbc.dialect !== "mssql" || !(await Bun.file(join(dirname(odbcEntry), "worker.ps1")).exists())) {
  throw new Error("Packaged ODBC worker is absent");
}

const sqlDatabase = SqlDatabase.create({ dialect: "sqlite", filename: ":memory:" });
await sqlDatabase.start();
const migrator = new SqlMigrator(sqlDatabase, [sqlMigration("001_records", [
  "CREATE TABLE records (id INTEGER PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL)",
])]);
await migrator.migrate();
const record = defineEntity<{ id: number; title: string; version: number }>({
  table: "records",
  columns: { id: { primaryKey: true }, title: {}, version: { version: true } },
});
const repository = new Repository(sqlDatabase, record);
await repository.insert({ id: 1, title: "original ORM", version: 1 });
const projected = await repository.query().where(item => item.id.eq(1)).select(item => ({ title: item.title })).toList();
if (projected[0]?.title !== "original ORM") throw new Error("Packaged ORM query failed");
const session = new OrmSession(sqlDatabase);
const tracked = await session.find(record, { id: 1 });
if (!tracked) throw new Error("Packaged ORM session failed");
tracked.title = "updated";
await session.flush();
session.dispose();
const authStore = new SqlSessionStore(sqlDatabase);
await new SqlMigrator(sqlDatabase, [authStore.migration()], { tableName: "auth_smoke_migrations" }).migrate();
await authStore.create({ tokenHash: "a".repeat(64), userId: "smoke-user", expiresAt: 20000 });
if ((await authStore.find("a".repeat(64), 10000))?.userId !== "smoke-user") throw new Error("Packaged authentication failed");
await new Gate<{ id: string }>().authorize({ id: "smoke-user" }, "smoke-user", (user, resource) => user.id === resource);
await sqlDatabase.close();
const storage = new StorageManager("local").register("local", new LocalStorage({ root: "storage" }));
await storage.disk().write("smoke/data.txt", "original storage");
if (new TextDecoder().decode(await storage.disk().read("smoke/data.txt")) !== "original storage") throw new Error("Packaged storage failed");

if (Environment.create({ PORT: "3000" }).integer("PORT") !== 3000) {
  throw new Error("Packaged config smoke test failed");
}

if (v.uuid().safeParse(crypto.randomUUID()).success !== true) {
  throw new Error("Packaged validation smoke test failed");
}

Logger.create({ level: "silent" }).info("ignored");
void new HttpError(400, "smoke");

const cliOutput: string[] = [];
if (await runCli({
  argv: ["help"],
  io: { error: (value) => cliOutput.push(value), log: (value) => cliOutput.push(value) },
}) !== 0 || cliOutput.length !== 1) {
  throw new Error("Packaged CLI smoke test failed");
}

await client.close();
`;
}

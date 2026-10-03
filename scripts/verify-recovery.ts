import { SqlDatabase, type SqlDialect } from "../packages/database/src/index.ts";

/** Destructive operations are confined to newly created, uniquely named test containers. */
const suffix = crypto.randomUUID().slice(0, 8);
const engines = [
  { dialect: "postgresql", image: "postgres:16.9", port: "5432", environment: ["POSTGRES_PASSWORD=bolt_recovery_test", "POSTGRES_DB=bolt_test"], user: "postgres" },
  { dialect: "mysql", image: "mysql:8.4.5", port: "3306", environment: ["MYSQL_ROOT_PASSWORD=bolt_recovery_test", "MYSQL_DATABASE=bolt_test", "MYSQL_ROOT_HOST=%"], user: "root" },
  { dialect: "mariadb", image: "mariadb:11.4.5", port: "3306", environment: ["MARIADB_ROOT_PASSWORD=bolt_recovery_test", "MARIADB_DATABASE=bolt_test", "MARIADB_ROOT_HOST=%"], user: "root" },
] as const;
async function docker(...args: string[]): Promise<string> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit) throw new Error(`Docker ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}
async function ready(database: SqlDatabase): Promise<void> {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { if (!database.isConnected) await database.start(); await database.execute("SELECT 1 AS ready"); return; } catch { await Bun.sleep(500); }
  }
  throw new Error("Database did not recover within 90 seconds");
}
for (const engine of engines) {
  if (Bun.env["BOLT_RECOVERY_DIALECT"] && Bun.env["BOLT_RECOVERY_DIALECT"] !== engine.dialect) continue;
  const name = `bolt-recovery-${engine.dialect}-${suffix}`;
  let created = false;
  let database: SqlDatabase | undefined;
  try {
    const temporaryListener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const fixedPort = temporaryListener.port;
    temporaryListener.stop(true);
    // An empty Docker HostPort is reassigned after restart; keep the endpoint stable.
    await docker("run", "-d", "--name", name, "--label", `bolt.integration=${suffix}`, ...engine.environment.flatMap(value => ["-e", value]), "-p", `127.0.0.1:${fixedPort}:${engine.port}`, engine.image);
    created = true;
    const address = await docker("port", name, `${engine.port}/tcp`);
    const port = /127\.0\.0\.1:(\d+)/.exec(address)?.[1];
    if (!port) throw new Error("Test container is not bound to localhost");
    database = SqlDatabase.create({ dialect: engine.dialect as SqlDialect, url: `${engine.dialect === "postgresql" ? "postgres" : "mysql"}://${engine.user}:bolt_recovery_test@127.0.0.1:${port}/bolt_test`, connectionTimeout: 2, maxConnections: 2, allowPublicKeyRetrieval: engine.dialect === "mysql" });
    console.log(`${engine.dialect}: waiting for initial database readiness`);
    await ready(database);
    await database.execute("CREATE TABLE bolt_recovery (id INTEGER PRIMARY KEY)");
    await database.execute("INSERT INTO bolt_recovery (id) VALUES (1)");
    let failed = false;
    try {
      await database.transaction(async transaction => {
        await transaction.execute("INSERT INTO bolt_recovery (id) VALUES (2)");
        await docker("stop", "--time", "2", name);
        await transaction.execute("SELECT id FROM bolt_recovery");
      });
    } catch { failed = true; }
    if (!failed) throw new Error("Disconnected transaction reported success");
    console.log(`${engine.dialect}: connection failure detected; restarting server`);
    await docker("start", name);
    await ready(database);
    const rows = (await database.execute("SELECT id FROM bolt_recovery ORDER BY id")).rows;
    if (rows.length !== 1 || Number(rows[0]?.["id"]) !== 1) throw new Error("Transaction rollback or durable recovery failed");
    await database.execute("INSERT INTO bolt_recovery (id) VALUES (3)");
    if ((await database.execute("SELECT id FROM bolt_recovery")).rows.length !== 2) throw new Error("Recovered pool cannot accept writes");
    console.log(`${engine.dialect}: disconnected transaction fails, rollback is durable, pool recovers and writes succeed`);
  } finally {
    await database?.close();
    if (created) {
      const identity = await docker("inspect", "--format", '{{index .Config.Labels "bolt.integration"}}', name);
      if (identity !== suffix) throw new Error("Refusing to remove a container not owned by this recovery run");
      await docker("rm", "-f", name);
    }
  }
}

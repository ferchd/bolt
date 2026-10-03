import { pathToFileURL } from "node:url";

interface RouteEntry { readonly method?: string; readonly name?: string }
interface RouterLike { compile(): Readonly<Record<string, Readonly<Record<string, unknown>>>> }
interface MigrationStatusLike { readonly appliedAt?: string | null; readonly id: string; readonly state: string }
interface MigratorLike {
  migrate(): readonly string[] | Promise<readonly string[]>;
  migrationStatus(): readonly MigrationStatusLike[] | Promise<readonly MigrationStatusLike[]>;
}
interface ConnectionLike {
  readonly isConnected?: boolean;
  start(options?: { readonly migrate?: boolean }): void | Promise<void>;
  stop(): void | Promise<void>;
}
type ModuleImporter = (specifier: string) => Promise<unknown>;

export async function listRoutes(applicationPath: string, importer: ModuleImporter): Promise<readonly string[]> {
  const module = asRecord(await importer(pathToFileURL(applicationPath).href));
  const router = resolveCapability<RouterLike>(module, "router", value => hasFunction(value, "compile"));
  const routes: string[] = [];
  for (const [path, route] of Object.entries(router.compile())) {
    if (typeof route["directory"] === "string") { routes.push(`STATIC ${path} -> ${route["directory"]}`); continue; }
    for (const value of Object.values(route)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as RouteEntry;
      if (typeof entry.method !== "string" && typeof entry.name !== "string") continue;
      routes.push(`${entry.method ?? "UNKNOWN"} ${path}${entry.name ? ` (${entry.name})` : ""}`);
    }
  }
  return routes;
}
export async function migrateDatabase(applicationPath: string, importer: ModuleImporter, connection?: string): Promise<readonly string[]> {
  return await withDatabase(applicationPath, importer, migrator => migrator.migrate(), connection);
}
export async function databaseMigrationStatus(applicationPath: string, importer: ModuleImporter, connection?: string): Promise<readonly string[]> {
  return await withDatabase(applicationPath, importer, async migrator =>
    (await migrator.migrationStatus()).map(({ appliedAt, id, state }) => `${state.toUpperCase()} ${id}${appliedAt ? ` ${appliedAt}` : ""}`), connection);
}
async function withDatabase<Result>(applicationPath: string, importer: ModuleImporter, callback: (migrator: MigratorLike) => Result | Promise<Result>, name?: string): Promise<Result> {
  const module = asRecord(await importer(pathToFileURL(applicationPath).href));
  let database: ConnectionLike;
  let migrator: MigratorLike;
  if (name) {
    const connections = resolveCapability<{ get(name: string): unknown }>(module, "connections", value => hasFunction(value, "get"));
    const value = connections.get(name);
    if (!isConnection(value)) throw new TypeError(`Connection ${name} must implement start and stop`);
    database = value;
    const catalog = resolveCapability<Readonly<Record<string, unknown>>>(module, "migrators", value => typeof value === "object" && value !== null);
    if (!Object.hasOwn(catalog, name) || !isMigrator(catalog[name])) throw new TypeError(`Application module must export migrators[${JSON.stringify(name)}]`);
    migrator = catalog[name];
  } else {
    database = resolveCapability(module, "database", isConnection);
    const explicit = capability(module, "migrator");
    if (explicit !== undefined && !isMigrator(explicit)) throw new TypeError("Exported migrator must implement migrate and migrationStatus");
    if (isMigrator(explicit)) migrator = explicit;
    else if (isMigrator(database)) migrator = database;
    else throw new TypeError("Application module must export a migrator capability (SqlMigrator) alongside database");
  }
  const ownsConnection = database.isConnected !== true;
  if (ownsConnection) await database.start({ migrate: false });
  let failure: unknown;
  let failed = false;
  try {
    // Await completion before cleanup, including failures in async migrations.
    return await callback(migrator);
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    if (ownsConnection) {
      try { await database.stop(); } catch (error) {
        if (failed) throw new AggregateError([failure, error], "Migration failed and connection cleanup also failed");
        throw error;
      }
    }
  }
}
function capability(module: Readonly<Record<string, unknown>>, name: string): unknown {
  return module[name] ?? asOptionalRecord(module["default"])?.[name];
}
function resolveCapability<Value>(module: Readonly<Record<string, unknown>>, name: string, predicate: (value: unknown) => boolean): Value {
  const direct = module[name];
  if (predicate(direct)) return direct as Value;
  const nested = asOptionalRecord(module["default"])?.[name];
  if (predicate(nested)) return nested as Value;
  throw new TypeError(`Application module must export a ${name} capability directly or through its default export`);
}
function isConnection(value: unknown): value is ConnectionLike { return hasFunction(value, "start") && hasFunction(value, "stop"); }
function isMigrator(value: unknown): value is MigratorLike { return hasFunction(value, "migrate") && hasFunction(value, "migrationStatus"); }
function hasFunction(value: unknown, name: string): boolean { return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[name] === "function"; }
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  const record = asOptionalRecord(value);
  if (!record) throw new TypeError("Application module must export an object");
  return record;
}
function asOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined { return typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : undefined; }

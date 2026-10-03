import { pathToFileURL } from "node:url";

interface RouteEntry {
  readonly method?: string;
  readonly name?: string;
}

interface RouterLike {
  compile(): Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface MigrationStatusLike {
  readonly appliedAt?: string | null;
  readonly id: string;
  readonly state: string;
}

interface DatabaseLike {
  readonly isConnected?: boolean;
  migrate(): readonly string[];
  migrationStatus(): readonly MigrationStatusLike[];
  start(options?: { readonly migrate?: boolean }): void | Promise<void>;
  stop(): void | Promise<void>;
}

type ModuleImporter = (specifier: string) => Promise<unknown>;

export async function listRoutes(
  applicationPath: string,
  importer: ModuleImporter,
): Promise<readonly string[]> {
  const module = asRecord(await importer(pathToFileURL(applicationPath).href));
  const router = resolveCapability<RouterLike>(module, "router", isRouter);
  const routes: string[] = [];

  for (const [path, route] of Object.entries(router.compile())) {
    if (typeof route["directory"] === "string") {
      routes.push(`STATIC ${path} -> ${route["directory"]}`);
      continue;
    }

    for (const value of Object.values(route)) {
      if (!isRouteEntry(value)) {
        continue;
      }

      routes.push(
        `${value.method ?? "UNKNOWN"} ${path}${value.name ? ` (${value.name})` : ""}`,
      );
    }
  }

  return routes;
}

export async function migrateDatabase(
  applicationPath: string,
  importer: ModuleImporter,
): Promise<readonly string[]> {
  return await withDatabase(applicationPath, importer, (database) =>
    database.migrate(),
  );
}

export async function databaseMigrationStatus(
  applicationPath: string,
  importer: ModuleImporter,
): Promise<readonly string[]> {
  return await withDatabase(applicationPath, importer, (database) =>
    database
      .migrationStatus()
      .map(
        ({ appliedAt, id, state }) =>
          `${state.toUpperCase()} ${id}${appliedAt ? ` ${appliedAt}` : ""}`,
      ),
  );
}

async function withDatabase<Result>(
  applicationPath: string,
  importer: ModuleImporter,
  callback: (database: DatabaseLike) => Result,
): Promise<Result> {
  const module = asRecord(await importer(pathToFileURL(applicationPath).href));
  const database = resolveCapability<DatabaseLike>(
    module,
    "database",
    isDatabase,
  );
  const ownsConnection = database.isConnected !== true;

  if (ownsConnection) {
    await database.start({ migrate: false });
  }

  try {
    return callback(database);
  } finally {
    if (ownsConnection) {
      await database.stop();
    }
  }
}

function resolveCapability<Value>(
  module: Readonly<Record<string, unknown>>,
  name: string,
  predicate: (value: unknown) => value is Value,
): Value {
  const direct = module[name];

  if (predicate(direct)) {
    return direct;
  }

  const defaultExport = asOptionalRecord(module["default"]);
  const nested = defaultExport?.[name];

  if (predicate(nested)) {
    return nested;
  }

  throw new TypeError(
    `Application module must export a ${name} capability directly or through its default export`,
  );
}

function isRouter(value: unknown): value is RouterLike {
  return hasFunction(value, "compile");
}

function isDatabase(value: unknown): value is DatabaseLike {
  return (
    hasFunction(value, "migrate") &&
    hasFunction(value, "migrationStatus") &&
    hasFunction(value, "start") &&
    hasFunction(value, "stop")
  );
}

function isRouteEntry(value: unknown): value is RouteEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    (typeof (value as RouteEntry).method === "string" ||
      typeof (value as RouteEntry).name === "string")
  );
}

function hasFunction(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    name in value &&
    typeof (value as Record<string, unknown>)[name] === "function"
  );
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Application module must export an object");
  }

  return value as Readonly<Record<string, unknown>>;
}

function asOptionalRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

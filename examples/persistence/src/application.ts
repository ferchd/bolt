import { createToken, provideFactory } from "@bolt/container";
import { Gate, SessionAuth, SqlSessionStore, type UserProvider } from "@bolt/auth";
import { SqlDatabase, SqlMigrator, SqlPostCommitError, sqlMigration, type SqlMigrationOptions } from "@bolt/database";
import { abort, BoltApplication } from "@bolt/kernel";
import { defineEntity, Repository } from "@bolt/orm";
import { OptimisticLockError, OrmReconciliationError } from "@bolt/orm";
import { Router } from "@bolt/router";
import { csrf, rateLimit, secureHeaders } from "@bolt/security";
import { LocalStorage, StorageManager, type StorageDisk } from "@bolt/storage";
import v from "@bolt/validation";

export interface Asset {
  id: string;
  title: string;
  objectKey: string | null;
  version: number;
}

export interface AssetUser { readonly id: string; readonly permissions: readonly string[] }

export const assetEntity = defineEntity<Asset>({
  table: "bolt_assets",
  columns: {
    id: { primaryKey: true },
    title: {},
    objectKey: { name: "object_key" },
    version: { version: true },
  },
});

const assets = createToken<Repository<Asset>>("asset repository");

const input = v.object({ title: v.string().min(1).max(255) });

const params = v.object({ id: v.uuid() });

/** Supply your SQL provider and storage disk; project layout is independent of either. */
export function createPersistenceApplication(options: {
  database: SqlDatabase;
  disk?: StorageDisk;
  port?: number;
  hostname?: string;
  migrationOptions?: SqlMigrationOptions;
  auth?: { users: UserProvider<AssetUser>; csrfSecret: string; secure?: boolean };
}) {

  const database = options.database;

  const storage = new StorageManager("assets").register("assets", options.disk ?? new LocalStorage({ root: "storage/assets" }));

  const dialect = database.dialect;
  const sessionStore = options.auth ? new SqlSessionStore(database) : undefined;
  const auth = options.auth && sessionStore ? new SessionAuth(options.auth.users, sessionStore, { secure: options.auth.secure }) : undefined;
  const csrfProtection = options.auth ? csrf({ secrets: options.auth.csrfSecret, secureCookie: options.auth.secure }) : undefined;
  const gate = new Gate<AssetUser>();

  const text = dialect === "oracle" ? "NVARCHAR2" : dialect === "mssql" ? "NVARCHAR" : "VARCHAR";
  const quote = (name: string) => dialect === "oracle" ? `"${name}"` : name;

  const migrator = new SqlMigrator(database, [sqlMigration("001_assets", [
    `CREATE TABLE ${quote("bolt_assets")} (${quote("id")} VARCHAR(36) PRIMARY KEY, ${quote("title")} ${text}(255) NOT NULL, ${quote("object_key")} VARCHAR(100), ${quote("version")} INTEGER NOT NULL)`,
  ], { transactional: !["mysql", "mariadb", "oracle"].includes(dialect) }), ...(sessionStore ? [sessionStore.migration("002_auth_sessions")] : [])], options.migrationOptions);

  const router = Router.create();
  const routes = router.group(() => {
    router.get("/health", () => ({ status: "ready", dialect }));
    if (auth && csrfProtection) {
      router.get("/auth/csrf", async context => ({ token: await csrfProtection.token(context) }));
      router.group(() => {
        router.post("/auth/login", async context => {
          const credentials = await context.validate.body(v.object({ login: v.string().min(1).max(255), password: v.string().min(1).max(1024) }));
          const user = await auth.login(context, credentials.login, credentials.password);
          // Providers may also contain internal account or credential fields.
          return { id: user.id, permissions: user.permissions };
        });
      }).use(rateLimit({ limit: 10, windowMs: 60_000 }));
      router.post("/auth/logout", async context => { await auth.logout(context); return new Response(null, { status: 204 }); });
      router.post("/auth/rotate", async context => { await auth.rotate(context); return new Response(null, { status: 204 }); });
    }
    router.group(() => {
    router.post("/assets", async context => {

      const value = await context.validate.body(input);

      const asset = await context.resolve(assets).insert({ id: crypto.randomUUID(), title: value.title, objectKey: null, version: 1 });
      return Response.json(asset, { status: 201 });
    });
    router.get("/assets", async context => {

      const title = context.query.get("title");
      let query = context.resolve(assets).query();
      if (title) query = query.where(asset => asset.title.eq(title));
      return await query.orderBy(asset => asset.id).take(50).toList();
    });
    router.put("/assets/:id/content", async context => {

      const { id } = await context.validate.params(params);

      const repository = context.resolve(assets);

      const asset = await repository.find({ id });
      if (!asset) abort(404, "Asset not found");
      if (!context.request.body) abort(400, "Upload body is required");

      const expected = context.header("if-match");
      if (expected !== `"${asset.version}"`) abort(412, "Supply the current asset version in If-Match");

      const disk = storage.disk();

      const key = `assets/${id}/${crypto.randomUUID()}`;
      await disk.write(key, context.request.body, {
        maxBytes: 8 * 1024 * 1024,
        ...(disk.capabilities.abortWrite ? { signal: context.signal } : {}),
        contentType: "application/octet-stream",
      });

      const previousKey = asset.objectKey;
      asset.objectKey = key;
      try {
        await repository.update(asset, ["objectKey"]);
      } catch (error) {
        // A confirmed COMMIT may still report a later connection cleanup failure.
        // Preserve the now-referenced blob; retrying or compensating would corrupt data.
        if (error instanceof SqlPostCommitError || error instanceof OrmReconciliationError) throw error;
        try { await disk.delete(key); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Upload metadata and cleanup failed");
        }
        if (error instanceof OptimisticLockError) abort(409, "Asset was changed by another writer");
        throw error;
      }
      if (previousKey) {
        try { await disk.delete(previousKey); } catch (error) {
          context.logger.warn("Old asset object requires cleanup", { error, assetId: id });
        }
      }
      return Response.json(asset, { headers: { etag: `"${asset.version}"` } });
    });
    router.get("/assets/:id/content", async context => {

      const { id } = await context.validate.params(params);

      const asset = await context.resolve(assets).find({ id });
      if (!asset?.objectKey) abort(404, "Asset content not found");
      return new Response(await storage.disk().readStream(asset.objectKey, { signal: context.signal }), {
        headers: { "content-type": "application/octet-stream", etag: `"${asset.version}"` },
      });
    });
    }).use(async (context, next) => {
      if (auth) {
        const user = await auth.require(context);
        const permission = ["GET", "HEAD"].includes(context.request.method) ? "assets.read" : "assets.write";
        await gate.authorize(user, permission, (current, required) => current.permissions.includes(required));
      }
      return await next();
    });
  }).use(secureHeaders());
  if (csrfProtection) routes.use(csrfProtection.middleware);

  const application = BoltApplication.create({
    router,
    port: options.port ?? 3000,
    hostname: options.hostname ?? "127.0.0.1",
    server: { maxRequestBodySize: 8 * 1024 * 1024 },
    hooks: {
      onResponse: (_context, response) => {
        // Includes CSRF, streams, and failed authentication responses.
        if (auth) response.headers.set("cache-control", "no-store");
      },
    },
    bindings: [provideFactory(assets, [], () => new Repository(database, assetEntity), { lifetime: "scoped" })],
  }).use(database).use({ start: async () => { await migrator.migrate(); } });
  return { application, router, database, migrator, storage, auth, sessionStore };
}

import env from "@bolt/config";
import { SqlDatabase } from "@bolt/database";
import { S3Storage } from "@bolt/storage";
import { createPersistenceApplication } from "./application.ts";

const dialect = env.oneOf("DATABASE_DIALECT", ["sqlite", "postgresql", "mysql", "mariadb"] as const, "sqlite");
const database = SqlDatabase.create({
  dialect,
  ...(dialect === "sqlite" ? { filename: env.string("DATABASE_PATH", "storage/assets.sqlite") } : { url: env.string("DATABASE_URL") }),
});
const disk = env.string("STORAGE_DISK", "local");
if (disk !== "local" && disk !== "s3") throw new Error("STORAGE_DISK must be local or s3");
// Resolve required credentials before accepting requests or reporting readiness.
const authUserId = env.string("AUTH_USER_ID");
const authLogin = env.string("AUTH_LOGIN");
const authPasswordHash = env.string("AUTH_PASSWORD_HASH");
if (!authUserId || authUserId.length > 255 || !authLogin || authLogin.length > 255) throw new Error("AUTH_USER_ID and AUTH_LOGIN must contain 1–255 characters");
if (!authPasswordHash.startsWith("$argon2id$")) throw new Error("AUTH_PASSWORD_HASH must use Argon2id");
const { application } = createPersistenceApplication({
  database,
  auth: {
    csrfSecret: env.string("CSRF_SECRET"),
    secure: env.string("AUTH_SECURE_COOKIE", "true") !== "false",
    users: {
      findById: async id => id === authUserId ? { id, permissions: ["assets.read", "assets.write"] } : null,
      findByLogin: async login => login === authLogin ? {
        user: { id: authUserId, permissions: ["assets.read", "assets.write"] }, passwordHash: authPasswordHash,
      } : null,
    },
  },
  port: env.integer("PORT", 3000),
  ...(disk === "s3" ? { disk: new S3Storage({
    bucket: env.string("S3_BUCKET"),
    endpoint: Bun.env["S3_ENDPOINT"],
    region: Bun.env["S3_REGION"],
    accessKeyId: env.string("S3_ACCESS_KEY_ID"),
    secretAccessKey: env.string("S3_SECRET_ACCESS_KEY"),
  }) } : {}),
});
await application.start();

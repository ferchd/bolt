import { createHash, randomBytes } from "node:crypto";
import { sqlMigration, type SqlExecutor, type SqlMigration } from "@bolt/database";
import { HttpError, type HttpContext, type Next } from "@bolt/http";
import { hashPassword, verifyPassword } from "@bolt/security";

export interface AuthUser { readonly id: string }
export interface Credential<User extends AuthUser> { readonly user: User; readonly passwordHash: string }
/** Resolve current status and permissions on every request; return null for disabled users. */
export interface UserProvider<User extends AuthUser> {
  findById(id: string): Promise<User | null>;
  findByLogin(login: string): Promise<Credential<User> | null>;
}
export interface SessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly expiresAt: number;
}
export interface SessionStore {
  find(tokenHash: string, now: number): Promise<SessionRecord | null>;
  create(record: SessionRecord, previousHash?: string): Promise<void>;
  rotate(previousHash: string, record: SessionRecord, now: number): Promise<boolean>;
  revoke(tokenHash: string): Promise<void>;
  revokeUser(userId: string): Promise<void>;
  purge(now: number): Promise<void>;
}

/** Only SHA-256 digests of random 256-bit tokens are persisted. No raw tokens or passwords. */
export class SqlSessionStore implements SessionStore {
  private readonly table: string;
  public constructor(private readonly database: SqlExecutor, table = "bolt_auth_sessions") {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(table)) throw new TypeError("Invalid session table name");
    this.table = table;
  }
  private quote(value: string): string {
    return this.database.dialect === "mysql" || this.database.dialect === "mariadb" ? `\`${value}\`` : `"${value}"`;
  }
  private marker(index: number): string {
    const dialect = this.database.dialect;
    return dialect === "postgresql" ? `$${index}` : dialect === "mssql" ? `@p${index}` : dialect === "oracle" ? `:p${index}` : "?";
  }
  private get columns(): string { return ["token_hash", "user_id", "expires_at"].map(name => this.quote(name)).join(", "); }
  public migration(id = "001_auth_sessions"): SqlMigration {
    const text = this.database.dialect === "oracle" ? "NVARCHAR2" : this.database.dialect === "mssql" ? "NVARCHAR" : "VARCHAR";
    const integer = this.database.dialect === "oracle" ? "NUMBER(19)" : "BIGINT";
    // Index names share a schema-wide namespace on several engines. Hash the
    // complete custom table name rather than truncating away its unique suffix.
    const indexPrefix = `ba_${createHash("sha256").update(this.table).digest("hex").slice(0, 20)}`;
    return sqlMigration(id, [
      `CREATE TABLE ${this.quote(this.table)} (${this.quote("token_hash")} ${text}(64) PRIMARY KEY, ${this.quote("user_id")} ${text}(255) NOT NULL, ${this.quote("expires_at")} ${integer} NOT NULL)`,
      `CREATE INDEX ${this.quote(`${indexPrefix}_user`)} ON ${this.quote(this.table)} (${this.quote("user_id")})`,
      `CREATE INDEX ${this.quote(`${indexPrefix}_expiry`)} ON ${this.quote(this.table)} (${this.quote("expires_at")})`,
    ], { transactional: !["mysql", "mariadb", "oracle"].includes(this.database.dialect) });
  }
  public async find(tokenHash: string, now: number): Promise<SessionRecord | null> {
    const result = await this.database.execute(`SELECT ${this.columns} FROM ${this.quote(this.table)} WHERE ${this.quote("token_hash")} = ${this.marker(1)} AND ${this.quote("expires_at")} > ${this.marker(2)}`, [tokenHash, now]);
    const row = result.rows[0];
    return row ? { tokenHash: String(row["token_hash"]), userId: String(row["user_id"]), expiresAt: Number(row["expires_at"]) } : null;
  }
  private async insert(executor: SqlExecutor, record: SessionRecord): Promise<void> {
    await executor.execute(`INSERT INTO ${this.quote(this.table)} (${this.columns}) VALUES (${this.marker(1)}, ${this.marker(2)}, ${this.marker(3)})`, [record.tokenHash, record.userId, record.expiresAt]);
  }
  public async create(record: SessionRecord, previousHash?: string): Promise<void> {
    assertRecord(record);
    await this.database.transaction(async executor => {
      if (previousHash) await executor.execute(`DELETE FROM ${this.quote(this.table)} WHERE ${this.quote("token_hash")} = ${this.marker(1)}`, [previousHash]);
      await this.insert(executor, record);
    });
  }
  public async rotate(previousHash: string, record: SessionRecord, now: number): Promise<boolean> {
    assertRecord(record);
    return this.database.transaction(async executor => {
      const result = await executor.execute(`DELETE FROM ${this.quote(this.table)} WHERE ${this.quote("token_hash")} = ${this.marker(1)} AND ${this.quote("user_id")} = ${this.marker(2)} AND ${this.quote("expires_at")} = ${this.marker(3)} AND ${this.quote("expires_at")} > ${this.marker(4)}`, [previousHash, record.userId, record.expiresAt, now]);
      if (result.affectedRows !== 1) return false;
      await this.insert(executor, record);
      return true;
    });
  }
  public async revoke(tokenHash: string): Promise<void> {
    await this.database.execute(`DELETE FROM ${this.quote(this.table)} WHERE ${this.quote("token_hash")} = ${this.marker(1)}`, [tokenHash]);
  }
  public async revokeUser(userId: string): Promise<void> {
    await this.database.execute(`DELETE FROM ${this.quote(this.table)} WHERE ${this.quote("user_id")} = ${this.marker(1)}`, [userId]);
  }
  public async purge(now: number): Promise<void> {
    await this.database.execute(`DELETE FROM ${this.quote(this.table)} WHERE ${this.quote("expires_at")} <= ${this.marker(1)}`, [now]);
  }
}

function assertRecord(record: SessionRecord): void {
  if (typeof record.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(record.tokenHash)) throw new TypeError("Session token digest must be lowercase SHA-256 hexadecimal");
  if (typeof record.userId !== "string" || !record.userId || record.userId.length > 255) throw new TypeError("Session user ID must contain 1–255 characters");
  if (!Number.isSafeInteger(record.expiresAt) || Math.abs(record.expiresAt) > 8_640_000_000_000_000) throw new RangeError("Session expiry must be a valid integer timestamp in milliseconds");
}

export interface SessionAuthOptions {
  readonly ttlSeconds?: number;
  readonly secure?: boolean;
  readonly cookieName?: string;
  readonly now?: () => number;
}
export class SessionAuth<User extends AuthUser> {
  private readonly ttl: number;
  private readonly secure: boolean;
  private readonly name: string;
  private readonly now: () => number;
  private dummyHash?: Promise<string>;
  public constructor(public readonly users: UserProvider<User>, public readonly store: SessionStore, options: SessionAuthOptions = {}) {
    this.ttl = options.ttlSeconds ?? 8 * 60 * 60;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 30 * 24 * 60 * 60) throw new RangeError("Session TTL must be 1–2592000 seconds");
    this.secure = options.secure ?? true;
    this.name = options.cookieName ?? (this.secure ? "__Host-bolt_session" : "bolt_session");
    if (!/^[A-Za-z0-9_-]+$/.test(this.name) || (!this.secure && /^__(Host|Secure)-/.test(this.name))) throw new TypeError("Invalid session cookie name or insecure cookie prefix");
    this.now = options.now ?? Date.now;
  }
  private token(context: HttpContext): string | undefined {
    const token = context.cookies.get(this.name);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  private hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private set(context: HttpContext, token: string, expiresAt: number): void {
    context.cookies.set(this.name, token, { path: "/", httpOnly: true, secure: this.secure, sameSite: "strict", expires: new Date(expiresAt) });
  }
  public async login(context: HttpContext, login: string, password: string): Promise<User> {
    if (login.length > 255) throw new HttpError(401, "Invalid credentials");
    const credential = await this.users.findByLogin(login);
    // Applications can warm this once at startup; unknown users still perform password verification.
    const hash = credential?.passwordHash ?? await (this.dummyHash ??= hashPassword(randomBytes(32).toString("hex")));
    const valid = await verifyPassword(password, hash);
    const current = credential && valid ? await this.users.findById(credential.user.id) : null;
    if (!current) throw new HttpError(401, "Invalid credentials");
    const token = randomBytes(32).toString("base64url");
    const record = { tokenHash: this.hash(token), userId: current.id, expiresAt: this.now() + this.ttl * 1000 };
    const previous = this.token(context);
    await this.store.create(record, previous ? this.hash(previous) : undefined);
    this.set(context, token, record.expiresAt);
    return current;
  }
  public async user(context: HttpContext): Promise<User | null> {
    const token = this.token(context);
    if (!token) return null;
    const record = await this.store.find(this.hash(token), this.now());
    return record ? await this.users.findById(record.userId) : null;
  }
  public async require(context: HttpContext): Promise<User> {
    const user = await this.user(context);
    if (!user) throw new HttpError(401, "Authentication required");
    return user;
  }
  public middleware(): (context: HttpContext, next: Next) => Promise<unknown> {
    return async (context, next) => { await this.require(context); return await next(); };
  }
  /** Rotation preserves the absolute expiry; concurrent rotations have exactly one winner. */
  public async rotate(context: HttpContext): Promise<void> {
    const previous = this.token(context);
    const now = this.now();
    const record = previous ? await this.store.find(this.hash(previous), now) : null;
    if (!previous || !record || !await this.users.findById(record.userId)) throw new HttpError(401, "Authentication required");
    const token = randomBytes(32).toString("base64url");
    if (!await this.store.rotate(this.hash(previous), { ...record, tokenHash: this.hash(token) }, now)) throw new HttpError(401, "Session is no longer valid");
    this.set(context, token, record.expiresAt);
  }
  public async logout(context: HttpContext): Promise<void> {
    const token = this.token(context);
    if (token) await this.store.revoke(this.hash(token));
    context.cookies.set(this.name, "", { path: "/", httpOnly: true, secure: this.secure, sameSite: "strict", maxAge: 0 });
  }
}

export type Policy<User, Resource> = (user: User, resource: Resource) => boolean | Promise<boolean>;
/** Resource and tenant ownership are explicit application policies, never inferred from routes. */
export class Gate<User> {
  public async allows<Resource>(user: User, resource: Resource, policy: Policy<User, Resource>): Promise<boolean> {
    return await policy(user, resource) === true;
  }
  public async authorize<Resource>(user: User, resource: Resource, policy: Policy<User, Resource>): Promise<void> {
    if (!await this.allows(user, resource, policy)) throw new HttpError(403, "Access denied");
  }
}

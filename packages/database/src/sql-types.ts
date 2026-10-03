import type { TLSOptions } from "bun";

export type SqlDialect = "sqlite" | "postgresql" | "mysql" | "mariadb" | "mssql" | "oracle";
export type SqlValue = string | number | bigint | boolean | Date | Uint8Array | null;
export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly affectedRows: number;
  readonly insertId?: string | number | bigint;
}
/** Output bindings are explicit because native driver support varies by provider. */
export interface SqlOutputParameter {
  readonly type: "string" | "decimal" | "number" | "bigint" | "binary" | "date";
  readonly size?: number;
}
export interface SqlOutputResult<Row extends Record<string, unknown> = Record<string, unknown>> extends SqlResult<Row> {
  readonly output: readonly unknown[];
}
export interface SqlTransactionOptions {
  readonly isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  readonly sqliteMode?: "deferred" | "immediate" | "exclusive";
}
export interface SqlExecutor {
  readonly dialect: SqlDialect;
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly SqlValue[]): Promise<SqlResult<Row>>;
  /** Output markers follow input markers: :p(inputCount + 1), then :p(inputCount + 2). */
  executeWithOutput?<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[], output: readonly SqlOutputParameter[]): Promise<SqlOutputResult<Row>>;
  transaction<T>(callback: (executor: SqlExecutor) => Promise<T>, options?: SqlTransactionOptions): Promise<T>;
}
/** A transport reservation must pin one physical connection until release. */
export interface SqlSession {
  execute<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly SqlValue[]): Promise<SqlResult<Row>>;
  executeWithOutput?<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly SqlValue[], output: readonly SqlOutputParameter[]): Promise<SqlOutputResult<Row>>;
  /** Discard a suspect physical connection before release instead of returning it to its pool. */
  invalidate?(): Promise<void>;
  release(): Promise<void>;
}
export interface SqlTransport {
  readonly dialect: SqlDialect;
  connect(): Promise<void>;
  reserve(): Promise<SqlSession>;
  close(): Promise<void>;
}
export interface SqlDatabaseOptions {
  readonly dialect: SqlDialect;
  readonly url?: string;
  readonly filename?: string;
  readonly readonly?: boolean;
  readonly busyTimeout?: number;
  readonly wal?: boolean;
  readonly maxConnections?: number;
  readonly connectionTimeout?: number;
  readonly idleTimeout?: number;
  readonly tls?: TLSOptions | boolean | "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  /** Explicit local-development opt-in for MySQL RSA authentication without TLS. */
  readonly allowPublicKeyRetrieval?: boolean;
  /** Explicit transport for engines without a native Bun implementation. */
  readonly transport?: SqlTransport;
}

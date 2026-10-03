import { Database } from "./database.ts";

const database = Database.create();

export default database;

export { Database } from "./database.ts";
export { SqlDatabase, SqlPostCommitError } from "./sql-database.ts";
export { SqlConnections } from "./sql-connections.ts";
export { SqlMigrator, sqlMigration } from "./sql-migrations.ts";
export type { SqlMigration, SqlMigrationOptions, SqlMigrationStatus } from "./sql-migrations.ts";
export type { SqlDatabaseState } from "./sql-database.ts";
export type { SqlDatabaseOptions, SqlDialect, SqlExecutor, SqlOutputParameter, SqlOutputResult, SqlResult, SqlSession, SqlTransactionOptions, SqlTransport, SqlValue } from "./sql-types.ts";

export type {
  DatabaseOptions,
  DatabaseStartOptions,
  DatabaseState,
  DatabaseTransaction,
  Migration,
  MigrationState,
  MigrationStatus,
} from "./database.ts";

export type {
  Changes,
  SQLQueryBindings,
  Statement,
} from "bun:sqlite";

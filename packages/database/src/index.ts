import { Database } from "./database.ts";

const database = Database.create();

export default database;

export { Database } from "./database.ts";

export type {
  DatabaseOptions,
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

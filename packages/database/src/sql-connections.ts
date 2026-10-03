import { AsyncLock } from "./sql-transports.ts";
import { SqlDatabase } from "./sql-database.ts";
import type { SqlDatabaseOptions } from "./sql-types.ts";

/** Explicit names avoid hidden global/default connections in multi-tenant applications. */
export class SqlConnections {
  readonly #databases = new Map<string, SqlDatabase>();
  readonly #lifecycle = new AsyncLock();
  #starting = false;
  add(name: string, database: SqlDatabase | SqlDatabaseOptions): this {
    if (this.#starting || [...this.#databases.values()].some((entry) => entry.state !== "stopped")) throw new Error("Register SQL connections before starting them");
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) throw new TypeError("Invalid SQL connection name");
    if (this.#databases.has(name)) throw new Error(`SQL connection ${name} is already registered`);
    this.#databases.set(name, database instanceof SqlDatabase ? database : SqlDatabase.create(database));
    return this;
  }
  get(name: string): SqlDatabase {
    const database = this.#databases.get(name);
    if (!database) throw new Error(`Unknown SQL connection ${name}`);
    return database;
  }
  get names(): readonly string[] { return Object.freeze([...this.#databases.keys()]); }
  async start(): Promise<void> {
    await this.#lifecycle.run(async () => {
      this.#starting = true;
      const started: SqlDatabase[] = [];
      try {
        for (const database of this.#databases.values()) {
          const running = database.isConnected;
          await database.start();
          if (!running) started.push(database);
        }
      } catch (error) {
        const cleanup = await Promise.allSettled(started.reverse().map((database) => database.close()));
        const failures = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
        if (failures.length) throw new AggregateError([error, ...failures], "SQL connections failed to start and clean up");
        throw error;
      } finally { this.#starting = false; }
    });
  }
  async close(): Promise<void> {
    await this.#lifecycle.run(async () => {
      const result = await Promise.allSettled([...this.#databases.values()].reverse().map((database) => database.close()));
      const failures = result.filter((entry) => entry.status === "rejected").map((entry) => entry.reason as unknown);
      if (failures.length) throw new AggregateError(failures, "SQL connections failed to close");
    });
  }
  async stop(): Promise<void> { await this.close(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

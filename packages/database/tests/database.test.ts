import { describe, expect, test } from "bun:test";

import { Database, type Migration } from "../src/index.ts";

describe("Database", () => {
  test("guards the native connection with an explicit lifecycle", () => {
    const database = Database.create({ filename: ":memory:" });

    expect(database.state).toBe("stopped");
    expect(database.isConnected).toBe(false);
    expect(() => database.connection).toThrow("Database has not been started");

    database.start();

    expect(database.state).toBe("running");
    expect(database.isConnected).toBe(true);
    expect(database.connection.filename).toBe(":memory:");

    database.stop();

    expect(database.state).toBe("stopped");
    expect(() => database.query("SELECT 1")).toThrow(
      "Database has not been started",
    );
  });

  test("runs cached queries with strict named bindings", () => {
    const database = startDatabase();

    try {
      database.run(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      );
      const insert = database.query<unknown, { name: string }>(
        "INSERT INTO users (name) VALUES ($name)",
      );

      expect(insert.run({ name: "Ada" }).changes).toBe(1);
      expect(
        database
          .query<{ id: number; name: string }, []>(
            "SELECT id, name FROM users",
          )
          .all(),
      ).toEqual([{ id: 1, name: "Ada" }]);
    } finally {
      database.stop();
    }
  });

  test("commits successful transactions and rolls back failures", () => {
    const database = startDatabase();

    try {
      database.run("CREATE TABLE events (name TEXT NOT NULL)");
      const insert = database.query<unknown, { name: string }>(
        "INSERT INTO events (name) VALUES ($name)",
      );
      const commit = database.transaction((name: string) => {
        insert.run({ name });
        return name.toUpperCase();
      });

      expect(commit("created")).toBe("CREATED");

      const rollback = database.transaction(() => {
        insert.run({ name: "discarded" });
        throw new Error("abort");
      });

      expect(rollback).toThrow("abort");
      expect(
        database
          .query<{ name: string }, []>("SELECT name FROM events")
          .all(),
      ).toEqual([{ name: "created" }]);
    } finally {
      database.stop();
    }
  });

  test("applies forward migrations once in deterministic id order", () => {
    const executionOrder: string[] = [];
    const migrations: Migration[] = [
      {
        id: "002_add_email",
        up(database) {
          executionOrder.push("002_add_email");
          database.run("ALTER TABLE users ADD COLUMN email TEXT");
        },
      },
      {
        id: "001_create_users",
        up(database) {
          executionOrder.push("001_create_users");
          database.run("CREATE TABLE users (id INTEGER PRIMARY KEY)");
        },
      },
    ];
    const database = Database.create({
      filename: ":memory:",
      migrations,
    });

    try {
      database.start();

      expect(executionOrder).toEqual([
        "001_create_users",
        "002_add_email",
      ]);
      expect(database.migrate()).toEqual([]);
      expect(executionOrder).toHaveLength(2);
      expect(
        database
          .query<{ id: string }, []>(
            "SELECT id FROM __bolt_migrations ORDER BY rowid",
          )
          .all(),
      ).toEqual([
        { id: "001_create_users" },
        { id: "002_add_email" },
      ]);
    } finally {
      database.stop();
    }
  });

  test("rejects duplicate and malformed migration ids before connecting", () => {
    const migration: Migration = {
      id: "001_create_users",
      up() {},
    };
    const database = Database.create({ migrations: [migration] });
    const nextMigration: Migration = {
      id: "002_add_email",
      up() {},
    };

    expect(() => database.register(migration)).toThrow(
      "Migration 001_create_users is already registered",
    );
    expect(() => database.register(nextMigration, migration)).toThrow(
      "Migration 001_create_users is already registered",
    );
    expect(() => database.register(nextMigration)).not.toThrow();
    expect(() =>
      database.register({ id: "invalid id", up() {} }),
    ).toThrow("Migration ids must start");
  });

  test("rejects asynchronous migrations instead of committing early", () => {
    const database = Database.create({
      filename: ":memory:",
      migrations: [
        {
          id: "001_async",
          async up() {},
        },
      ],
    });

    expect(() => database.start()).toThrow(
      "Migration 001_async returned a Promise",
    );
    expect(database.state).toBe("stopped");
  });

  test("is structurally compatible with application services", () => {
    type ApplicationService = {
      start?(application: unknown): void | PromiseLike<void>;
      stop?(application: unknown): void | PromiseLike<void>;
    };

    const service: ApplicationService = Database.create({
      filename: ":memory:",
    });

    service.start?.({});
    service.stop?.({});
  });
});

function startDatabase(): Database {
  const database = Database.create({ filename: ":memory:" });
  database.start();
  return database;
}

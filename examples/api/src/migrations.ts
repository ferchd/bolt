import type { Migration } from "@bolt/database";

export const taskMigrations: readonly Migration[] = [
  {
    id: "001_create_tasks",
    up(database) {
      database.run(`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
];

import { Database } from "../../src/index.ts";
import { appendFileSync, readFileSync } from "node:fs";

const filename = process.argv[2];
const barrier = process.argv[3];

if (!filename || !barrier) {
  throw new Error("Database and barrier filenames are required");
}

const database = Database.create({
  busyTimeout: 5_000,
  filename,
  migrateOnStart: false,
  migrations: [
    {
      id: "001_concurrent",
      up(database) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        database.run(
          "CREATE TABLE concurrent_proof (id INTEGER PRIMARY KEY)",
        );
        database.run("INSERT INTO concurrent_proof (id) VALUES (1)");
      },
    },
  ],
  wal: false,
});

try {
  database.start();
  appendFileSync(barrier, `${process.pid}\n`);

  while (readFileSync(barrier, "utf8").trim().split("\n").length < 2) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }

  database.migrate();
} finally {
  database.stop();
}

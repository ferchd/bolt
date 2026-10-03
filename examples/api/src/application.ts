import env from "@bolt/config";
import { Database } from "@bolt/database";
import {
  BoltApplication,
  type ApplicationOptions,
} from "@bolt/kernel";
import { Router } from "@bolt/router";

import { taskMigrations } from "./migrations.ts";
import { registerRoutes } from "./routes.ts";

export interface TaskApplicationOptions {
  readonly application?: Omit<ApplicationOptions, "router">;
  readonly databaseFilename?: string;
  readonly name?: string;
}

export interface TaskApplication {
  readonly application: BoltApplication;
  readonly database: Database;
  readonly router: Router;
}

export function createTaskApplication(
  options: TaskApplicationOptions = {},
): TaskApplication {
  const database = Database.create({
    filename:
      options.databaseFilename ??
      env.string("DATABASE_PATH", "storage/tasks.sqlite"),
    migrations: taskMigrations,
  });
  const router = Router.create();

  registerRoutes(
    router,
    database,
    options.name ?? env.string("APP_NAME", "Bolt Tasks"),
  );

  const application = BoltApplication.create({
    ...options.application,
    router,
  }).use(database);

  return { application, database, router };
}

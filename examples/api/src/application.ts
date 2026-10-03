import env from "@bolt/config";
import {
  provideClass,
  provideValue,
} from "@bolt/container";
import { Database } from "@bolt/database";
import {
  BoltApplication,
  type ApplicationProvider,
  type ApplicationOptions,
} from "@bolt/kernel";
import { Router } from "@bolt/router";
import {
  cors,
  csrf,
  hashPassword,
  rateLimit,
  secureHeaders,
  SignedCookies,
} from "@bolt/security";

import { taskMigrations } from "./migrations.ts";
import { registerRoutes } from "./routes.ts";
import { TasksController } from "./tasks-controller.ts";
import {
  applicationNameToken,
  databaseToken,
  tasksControllerToken,
} from "./tokens.ts";

export interface TaskApplicationOptions {
  readonly application?: Omit<ApplicationOptions, "router">;
  readonly databaseFilename?: string;
  readonly demoPassword?: string;
  readonly name?: string;
  readonly securitySecret?: string;
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
    migrateOnStart: env.boolean("DATABASE_MIGRATE_ON_START", true),
  });
  const router = Router.create();
  const name = options.name ?? env.string("APP_NAME", "Bolt Tasks");
  const securitySecret = options.securitySecret ?? env.string(
    "APP_KEY",
    "development-only-secret-change-before-production",
  );
  const secureCookie = env.boolean("COOKIE_SECURE", false);
  const csrfProtection = csrf({
    secrets: securitySecret,
    secureCookie,
  });
  let demoPasswordHash: Promise<string> | undefined;
  const security = {
    csrf: csrfProtection,
    passwordHash: () => demoPasswordHash ??= hashPassword(
      options.demoPassword ??
        env.string("DEMO_PASSWORD", "bolt-demo-password"),
    ),
    rateLimit: rateLimit({ limit: 100, windowMs: 60_000 }),
    secureCookie,
    sessions: SignedCookies.create({ secrets: securitySecret }),
  };
  const taskProvider: ApplicationProvider = {
    register(container) {
      container.register(
        provideValue(applicationNameToken, name),
        provideValue(databaseToken, database),
        provideClass(
          tasksControllerToken,
          [databaseToken],
          TasksController,
        ),
      );
    },
  };

  router
    .group(() => registerRoutes(router, security))
    .use([secureHeaders(), cors()]);

  const application = BoltApplication.create({
    ...options.application,
    providers: [...(options.application?.providers ?? []), taskProvider],
    requests: {
      trustProxy: env.boolean("TRUST_PROXY", false),
      ...options.application?.requests,
    },
    router,
  }).use(database);

  return { application, database, router };
}

export const { application, database, router } = createTaskApplication();

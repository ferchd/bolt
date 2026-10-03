import { createToken } from "@bolt/container";
import type { Database } from "@bolt/database";

import type { TasksController } from "./tasks-controller.ts";

export const applicationNameToken = createToken<string>("application name");
export const databaseToken = createToken<Database>("database");
export const tasksControllerToken = createToken<TasksController>(
  "tasks controller",
);

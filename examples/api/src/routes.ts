import type { Router } from "@bolt/router";

import {
  applicationNameToken,
  databaseToken,
  tasksControllerToken,
} from "./tokens.ts";

export function registerRoutes(router: Router): void {
  router.get("/health", (context) => {
    const database = context.resolve(databaseToken);
    const result = database
      .query<{ alive: number }, []>("SELECT 1 AS alive")
      .get();

    return {
      application: context.resolve(applicationNameToken),
      database: result?.alive === 1 ? "up" : "down",
      requestId: context.requestId,
      status: "ok",
    };
  }).as("health");

  router
    .group(() => {
      router.get("/", [tasksControllerToken, "index"]).as("index");
      router.post("/", [tasksControllerToken, "store"]).as("store");
      router.get("/:id", [tasksControllerToken, "show"]).as("show");
      router.patch("/:id", [tasksControllerToken, "update"]).as("update");
      router.delete("/:id", [tasksControllerToken, "destroy"]).as("destroy");
    })
    .prefix("/api/tasks")
    .as("tasks");
}

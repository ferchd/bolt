import { abort } from "@bolt/kernel";
import type { Router } from "@bolt/router";
import {
  type CsrfProtection,
  type RateLimitMiddleware,
  type SignedCookies,
  verifyPassword,
} from "@bolt/security";
import v from "@bolt/validation";

import {
  applicationNameToken,
  databaseToken,
  tasksControllerToken,
} from "./tokens.ts";

export interface ExampleSecurity {
  readonly csrf: CsrfProtection;
  readonly passwordHash: () => Promise<string>;
  readonly rateLimit: RateLimitMiddleware;
  readonly secureCookie: boolean;
  readonly sessions: SignedCookies;
}

const loginSchema = v.object({
  password: v.string().min(1).max(1_024),
  username: v.literal("bolt"),
});

export function registerRoutes(
  router: Router,
  security: ExampleSecurity,
): void {
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
    .as("tasks")
    .use(security.rateLimit);

  router
    .group(() => {
      router.get("/csrf", async (context) => ({
        token: await security.csrf.token(context),
      })).as("csrf");

      router
        .post("/session", async (context) => {
          const input = await context.validate.body(loginSchema);

          if (
            !await verifyPassword(input.password, await security.passwordHash())
          ) {
            abort(401, "Invalid credentials", { code: "INVALID_CREDENTIALS" });
          }

          await security.sessions.set(
            context.cookies,
            "bolt_session",
            input.username,
            { secure: security.secureCookie },
          );
          return { user: input.username };
        })
        .as("session.store")
        .use(security.csrf.middleware);

      router.get("/session", async (context) => ({
        user: await security.sessions.get(context.cookies, "bolt_session"),
      })).as("session.show");

      router
        .delete("/session", (context) => {
          security.sessions.delete(context.cookies, "bolt_session");
          return new Response(null, { status: 204 });
        })
        .as("session.destroy")
        .use(security.csrf.middleware);
    })
    .prefix("/api/security")
    .as("security");

  router.options("/api/*", () => new Response(null, { status: 204 }));
}

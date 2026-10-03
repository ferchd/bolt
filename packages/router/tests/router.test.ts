import { describe, expect, test } from "bun:test";

import { Router } from "../src/index.ts";

describe("Router", () => {
  test("compiles routes into a path and method table", () => {
    const router = Router.create();
    const handler = () => ({ hello: "world" });

    router.get("/", handler);
    router.post("users", handler);

    const routes = router.compile();

    expect(routes["/"]?.GET?.handler).toBe(handler);
    expect(routes["/users"]?.POST?.handler).toBe(handler);
  });

  test("compiles nested groups after applying their configuration", () => {
    const router = Router.create();
    const authMiddleware = () => undefined;

    router
      .group(() => {
        router
          .group(() => {
            router.post("signup", () => "signup").as("signup");
            router.post("login", () => "login").as("login");
          })
          .prefix("auth")
          .as("auth");

        router
          .group(() => {
            router.get("profile", () => "profile").as("show");
            router.post("logout", () => "logout");
          })
          .prefix("account")
          .as("account")
          .use(authMiddleware);
      })
      .prefix("/api/v1")
      .as("api");

    const routes = router.compile();

    expect(routes["/api/v1/auth/signup"]?.POST?.name).toBe(
      "api.auth.signup",
    );
    expect(routes["/api/v1/auth/login"]?.POST?.name).toBe("api.auth.login");
    expect(routes["/api/v1/account/profile"]?.GET?.name).toBe(
      "api.account.show",
    );
    expect(routes["/api/v1/account/profile"]?.GET?.middleware).toEqual([
      authMiddleware,
    ]);
  });

  test("preserves group and route middleware order", () => {
    const router = Router.create();
    const outer = () => "outer";
    const inner = () => "inner";
    const local = () => "local";

    router
      .group(() => {
        router
          .group(() => {
            router.get("status", () => "ok").use(local);
          })
          .use(inner);
      })
      .prefix("api")
      .use(outer);

    expect(router.compile()["/api/status"]?.GET?.middleware).toEqual([
      outer,
      inner,
      local,
    ]);
  });

  test("preserves controller handlers for the HTTP dispatcher", () => {
    const router = Router.create();

    class AccountsController {
      public store(): string {
        return "created";
      }
    }

    const handler = [AccountsController, "store"] as const;
    router.post("accounts", handler);

    expect(router.compile()["/accounts"]?.POST?.handler).toBe(handler);
  });

  test("supports fluent route names and middleware", () => {
    const router = Router.create();
    const middleware = () => undefined;

    router.get("users", () => []).as("users.index").use(middleware);

    const route = router.compile()["/users"]?.GET;

    expect(route?.name).toBe("users.index");
    expect(route?.middleware).toEqual([middleware]);
  });

  test("rejects duplicate methods for the same path", () => {
    const router = Router.create();

    router.get("status", () => "first");
    router.get("/status", () => "second");

    expect(() => router.compile()).toThrow("Duplicate route: GET /status");
  });

  test("rejects duplicate route names", () => {
    const router = Router.create();

    router.get("users", () => []).as("users.index");
    router.get("accounts", () => []).as("users.index");

    expect(() => router.compile()).toThrow(
      "Duplicate route name: users.index",
    );
  });
});

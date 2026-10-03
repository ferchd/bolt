import { afterEach, describe, expect, test } from "bun:test";
import { Router } from "@bolt/router";

import {
  BoltApplication,
  type HttpContext,
  type Next,
} from "../src/index.ts";

describe("BoltApplication HTTP lifecycle", () => {
  let application: BoltApplication | undefined;

  afterEach(async () => {
    await application?.stop();
  });

  test("starts the server and serializes handler results", async () => {
    const router = Router.create();
    router.get("/", () => ({ hello: "world" }));

    application = BoltApplication.create({
      hostname: "127.0.0.1",
      port: 0,
      router,
    });

    await application.start();
    const response = await fetch(application.url);

    expect(application.isRunning).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });

    await application.stop();

    expect(application.isRunning).toBe(false);
  });

  test("exposes Bun route params through the HTTP context", async () => {
    const router = Router.create();
    router.get("/users/:id", ({ params }: HttpContext) => params);
    application = createApplication(router);

    await application.start();
    const response = await fetch(new URL("/users/42", application.url));

    expect(await response.json()).toEqual({ id: "42" });
  });

  test("creates a controller instance for every request", async () => {
    const router = Router.create();

    class CounterController {
      #count = 0;

      public show(): { count: number } {
        this.#count += 1;
        return { count: this.#count };
      }
    }

    router.get("/counter", [CounterController, "show"]);
    application = createApplication(router);

    await application.start();
    const first = await fetch(new URL("/counter", application.url));
    const second = await fetch(new URL("/counter", application.url));

    expect(await first.json()).toEqual({ count: 1 });
    expect(await second.json()).toEqual({ count: 1 });
  });

  test("resolves lazy controllers", async () => {
    const router = Router.create();

    class LazyController {
      public show(): { loaded: boolean } {
        return { loaded: true };
      }
    }

    router.get("/lazy", [
      async () => ({ default: LazyController }),
      "show",
    ]);
    application = createApplication(router);

    await application.start();
    const response = await fetch(new URL("/lazy", application.url));

    expect(await response.json()).toEqual({ loaded: true });
  });

  test("runs middleware around the route handler", async () => {
    const router = Router.create();
    const calls: string[] = [];

    router
      .get("/middleware", () => {
        calls.push("handler");
        return "ok";
      })
      .use(async (_context: HttpContext, next: Next) => {
        calls.push("before");
        const result = await next();
        calls.push("after");
        return result;
      });

    application = createApplication(router);

    await application.start();
    const response = await fetch(new URL("/middleware", application.url));

    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["before", "handler", "after"]);
  });

  test("returns an empty 404 for unmatched requests", async () => {
    application = createApplication(Router.create());

    await application.start();
    const response = await fetch(new URL("/missing", application.url));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

function createApplication(router: Router): BoltApplication {
  return BoltApplication.create({
    hostname: "127.0.0.1",
    port: 0,
    router,
  });
}

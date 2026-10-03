import { afterEach, describe, expect, test } from "bun:test";
import {
  createToken,
  provideClass,
  provideFactory,
  provideValue,
} from "@bolt/container";
import { Router } from "@bolt/router";

import {
  abort,
  BoltApplication,
  Logger,
  type HttpContext,
  type Next,
} from "../src/index.ts";

describe("BoltApplication HTTP lifecycle", () => {
  let application: BoltApplication | undefined;

  afterEach(async () => {
    await application?.stop();
  });

  test("isolates request services and releases them on successful and failed requests", async () => {
    const resource = createToken<{ id: number; dispose(): void }>("request session");
    const disposed: number[] = [];
    let created = 0;
    const router = Router.create();
    router.get("/scope", async context => {
      const session = context.resolve(resource);
      expect(context.resolve(resource)).toBe(session);
      await Bun.sleep(2);
      return { id: session.id };
    });
    router.get("/failure", context => {
      context.resolve(resource);
      throw new Error("expected failure");
    });
    application = BoltApplication.create({
      port: 0,
      router,
      bindings: [provideFactory(resource, [], () => {
        const id = ++created;
        return { id, dispose() { disposed.push(id); } };
      }, { lifetime: "scoped" })],
    });
    await application.start();
    const responses = await Promise.all([1, 2].map(() => fetch(new URL("/scope", application!.url))));
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(new Set(bodies.map(body => body.id)).size).toBe(2);
    const failure = await fetch(new URL("/failure", application.url));
    expect(failure.status).toBe(500);
    await failure.text();
    expect(disposed.sort()).toEqual([1, 2, 3]);
  });

  test("keeps request resources alive until a streamed response finishes", async () => {
    const token = createToken<{ dispose(): void }>("stream resource");
    let disposed = false;
    const router = Router.create();
    router.get("/stream", context => {
      context.resolve(token);
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          await Bun.sleep(15);
          expect(disposed).toBe(false);
          controller.enqueue(new TextEncoder().encode("last"));
          controller.close();
        },
      }));
    });
    application = BoltApplication.create({ port: 0, router, bindings: [
      provideFactory(token, [], () => ({ dispose() { disposed = true; } }), { lifetime: "scoped" }),
    ] });
    await application.start();
    const response = await fetch(new URL("/stream", application.url));
    expect(await response.text()).toBe("firstlast");
    expect(disposed).toBe(true);
  });

  test("releases scoped services after a client aborts streaming", async () => {
    const token = createToken<{ dispose(): void }>("aborted stream resource");
    let release!: () => void;
    const disposed = new Promise<void>(resolve => { release = resolve; });
    const router = Router.create();
    router.get("/abort-stream", context => {
      context.resolve(token);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8192)); },
      }));
    });
    application = BoltApplication.create({ port: 0, router, bindings: [
      provideFactory(token, [], () => ({ dispose() { release(); } }), { lifetime: "scoped" }),
    ] });
    await application.start();
    const abort = new AbortController();
    const response = await fetch(new URL("/abort-stream", application.url), { signal: abort.signal });
    expect(response.status).toBe(200);
    abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([disposed, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Aborted request leaked its scope")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  });

  test("releases scoped services when HEAD suppresses a response body", async () => {
    const token = createToken<{ dispose(): void }>("HEAD resource");
    let disposed = false;
    const router = Router.create();
    router.head("/metadata", context => {
      context.resolve(token);
      return new Response("body excluded by HEAD");
    });
    application = BoltApplication.create({ port: 0, router, bindings: [
      provideFactory(token, [], () => ({ dispose() { disposed = true; } }), { lifetime: "scoped" }),
    ] });
    await application.start();
    const response = await fetch(new URL("/metadata", application.url), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(disposed).toBe(true);
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
    router.get("/users/:id", (context) => ({
      draft: context.query.get("draft"),
      id: context.params["id"],
    }));
    application = createApplication(router);

    await application.start();
    const response = await fetch(
      new URL("/users/42?draft=true", application.url),
    );

    expect(await response.json()).toEqual({ draft: "true", id: "42" });
  });

  test("parses request bodies and applies cookie changes", async () => {
    const router = Router.create();
    router.post("/users", async (context) => {
      const body = await context.json<{ name: string }>();
      context.cookies.set("visited", "true");
      return { name: body.name };
    });
    application = createApplication(router);

    await application.start();
    const response = await fetch(new URL("/users", application.url), {
      body: JSON.stringify({ name: "Ada" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(await response.json()).toEqual({ name: "Ada" });
    expect(response.headers.get("set-cookie")).toContain("visited=true");
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

  test("resolves controllers and services from the application container", async () => {
    const prefix = createToken<string>("greeting prefix");
    const controller = createToken<GreetingController>(
      "greeting controller",
    );

    class GreetingController {
      public constructor(private readonly greetingPrefix: string) {}

      public show(context: HttpContext): { greeting: string; service: string } {
        return {
          greeting: `${this.greetingPrefix}, Bolt`,
          service: context.resolve(prefix),
        };
      }
    }

    const router = Router.create();
    router.get("/injected", [controller, "show"]);
    application = BoltApplication.create({
      bindings: [
        provideValue(prefix, "Hello"),
        provideClass(controller, [prefix], GreetingController),
      ],
      port: 0,
      router,
    });

    await application.start();
    const response = await fetch(new URL("/injected", application.url));

    expect(await response.json()).toEqual({
      greeting: "Hello, Bolt",
      service: "Hello",
    });
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
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(await response.text()).toBe("");
  });

  test("renders expected errors without leaking unexpected ones", async () => {
    const router = Router.create();
    router.get("/expected", () =>
      abort(422, "Email is required", { code: "INVALID_INPUT" }),
    );
    router.get("/unexpected", () => {
      throw new Error("database password leaked");
    });
    application = BoltApplication.create({
      development: false,
      hostname: "127.0.0.1",
      port: 0,
      router,
    });

    await application.start();
    const expected = await fetch(new URL("/expected", application.url));
    const unexpected = await fetch(new URL("/unexpected", application.url));

    expect(expected.status).toBe(422);
    expect(await expected.json()).toEqual({
      error: { code: "INVALID_INPUT", message: "Email is required" },
    });
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
      },
    });
  });

  test("rejects request bodies larger than the configured limit", async () => {
    const router = Router.create();
    router.post("/upload", async (context) => ({
      size: (await context.text()).length,
    }));
    application = BoltApplication.create({
      port: 0,
      router,
      server: { maxRequestBodySize: 16 },
    });
    await application.start();

    const response = await fetch(new URL("/upload", application.url), {
      body: "x".repeat(32),
      method: "POST",
    });

    expect(response.status).toBe(413);
  });

  test("adds request observability and honors trusted proxy metadata", async () => {
    const router = Router.create();
    const events: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    const logger = Logger.create({
      format: "json",
      level: "info",
      writer: (line) => records.push(JSON.parse(line)),
    });
    router.get("/trace", (context) => {
      context.timeout(5);
      context.logger.info("Inside handler");
      return {
        clientIp: context.clientIp,
        requestId: context.requestId,
      };
    });
    application = BoltApplication.create({
      hooks: {
        onRequest: () => {
          events.push("request");
        },
        onResponse: (_context, response, durationMs) => {
          events.push(`response:${response.status}`);
          expect(durationMs).toBeGreaterThanOrEqual(0);
        },
      },
      logger,
      port: 0,
      requests: { trustProxy: true },
      router,
    });
    await application.start();

    const response = await fetch(new URL("/trace", application.url), {
      headers: {
        "x-forwarded-for": "203.0.113.10, 127.0.0.1",
        "x-request-id": "request-42",
      },
    });

    expect(response.headers.get("x-request-id")).toBe("request-42");
    expect(await response.json()).toEqual({
      clientIp: "203.0.113.10",
      requestId: "request-42",
    });
    expect(events).toEqual(["request", "response:200"]);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Inside handler",
          requestId: "request-42",
        }),
        expect.objectContaining({
          message: "Request completed",
          requestId: "request-42",
          status: 200,
        }),
      ]),
    );
  });
});

function createApplication(router: Router): BoltApplication {
  return BoltApplication.create({
    hostname: "127.0.0.1",
    port: 0,
    router,
  });
}

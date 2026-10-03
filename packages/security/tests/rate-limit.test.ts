import { describe, expect, test } from "bun:test";

import { rateLimit } from "../src/index.ts";
import { context } from "./helpers.ts";

describe("rateLimit", () => {
  test("limits each key and returns standard metadata", async () => {
    const middleware = rateLimit({ limit: 2, windowMs: 60_000 });
    const client = context();

    const first = (await middleware(client, async () => "first")) as Response;
    const second = (await middleware(client, async () => "second")) as Response;
    const denied = (await middleware(client, async () => "never")) as Response;

    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(await denied.json()).toEqual({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
      },
    });
  });

  test("supports custom keys, bounded storage and clearing", async () => {
    const middleware = rateLimit({
      key: (value) => value.request.headers.get("x-user-id"),
      limit: 1,
      maxEntries: 2,
    });

    for (const id of ["one", "two", "three"]) {
      await middleware(
        context(
          new Request("https://example.test", {
            headers: { "x-user-id": id },
          }),
        ),
        async () => undefined,
      );
    }

    expect(middleware.size()).toBe(2);
    middleware.clear();
    expect(middleware.size()).toBe(0);
  });

  test("resets expired windows", async () => {
    const middleware = rateLimit({ limit: 1, windowMs: 1 });
    const client = context();

    expect((await middleware(client, async () => "ok") as Response).status).toBe(200);
    await Bun.sleep(5);
    expect((await middleware(client, async () => "ok") as Response).status).toBe(200);
  });

  test("validates resource limits", () => {
    expect(() => rateLimit({ limit: 0 })).toThrow();
    expect(() => rateLimit({ maxEntries: 0 })).toThrow();
    expect(() => rateLimit({ windowMs: 1.5 })).toThrow();
  });
});

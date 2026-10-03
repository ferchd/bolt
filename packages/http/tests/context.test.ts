import { describe, expect, test } from "bun:test";
import { Container, createToken, provideValue } from "@bolt/container";

import { HttpContext } from "../src/index.ts";
import v from "@bolt/validation";

const route = { method: "POST", name: "users.store", path: "/users/:id" };

describe("HttpContext", () => {
  test("exposes request metadata, params, query and cookies", () => {
    const request = new Request("http://localhost/users/42?draft=true", {
      headers: {
        cookie: "session=abc123",
        "x-request-id": "request-1",
      },
    });
    const messages: string[] = [];
    const context = new HttpContext(request, {
      clientIp: "127.0.0.1",
      logger: {
        debug: () => undefined,
        error: () => undefined,
        info: (message) => messages.push(message),
        warn: () => undefined,
      },
      params: { id: "42" },
      requestId: "request-1",
      route,
    });
    context.logger.info("handled");

    expect(context.clientIp).toBe("127.0.0.1");
    expect(context.params).toEqual({ id: "42" });
    expect(context.query.get("draft")).toBe("true");
    expect(context.cookies.get("session")).toBe("abc123");
    expect(context.header("x-request-id")).toBe("request-1");
    expect(context.requestId).toBe("request-1");
    expect(context.url.pathname).toBe("/users/42");
    expect(messages).toEqual(["handled"]);
  });

  test("controls per-request timeouts when attached to a server", () => {
    const calls: number[] = [];
    const context = new HttpContext(new Request("http://localhost"), {
      route,
      timeout: (seconds) => calls.push(seconds),
    });

    context.timeout(30);

    expect(calls).toEqual([30]);
    expect(() => context.timeout(256)).toThrow("Request timeout");
  });

  test("resolves typed application services", () => {
    const name = createToken<string>("application name");
    const services = Container.create(provideValue(name, "Bolt"));
    const context = new HttpContext(new Request("http://localhost"), {
      route,
      services,
    });

    expect(context.resolve(name)).toBe("Bolt");
  });

  test("parses JSON without erasing the requested type", async () => {
    const request = new Request("http://localhost/users", {
      body: JSON.stringify({ name: "Ada" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const context = new HttpContext(request, { route });
    const body = await context.json<{ name: string }>();

    expect(body.name).toBe("Ada");
  });

  test("validates body, query and route parameters", async () => {
    const request = new Request(
      "http://localhost/users/42?active=true&role=admin&role=author",
      {
        body: JSON.stringify({ email: "ada@example.com" }),
        method: "POST",
      },
    );
    const context = new HttpContext(request, {
      params: { id: "42" },
      route,
    });

    expect(
      await context.validate.body(v.object({ email: v.string().email() })),
    ).toEqual({ email: "ada@example.com" });
    expect(
      context.validate.query(
        v.object({
          active: v.boolean(),
          role: v.array(v.string()),
        }),
      ),
    ).toEqual({ active: true, role: ["admin", "author"] });
    expect(
      context.validate.params(v.object({ id: v.number().integer() })),
    ).toEqual({ id: 42 });
  });
});

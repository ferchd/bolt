import { describe, expect, test } from "bun:test";

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
    const context = new HttpContext(request, {
      params: { id: "42" },
      route,
    });

    expect(context.params).toEqual({ id: "42" });
    expect(context.query.get("draft")).toBe("true");
    expect(context.cookies.get("session")).toBe("abc123");
    expect(context.header("x-request-id")).toBe("request-1");
    expect(context.url.pathname).toBe("/users/42");
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

import { describe, expect, test } from "bun:test";

import { cors, secureHeaders } from "../src/index.ts";
import { context } from "./helpers.ts";

describe("secureHeaders", () => {
  test("adds secure defaults and only emits HSTS over HTTPS", async () => {
    const middleware = secureHeaders();
    const secure = await middleware(context(), async () => ({ ok: true }));
    const insecure = await middleware(
      context("http://example.test"),
      async () => "ok",
    );

    expect(secure).toBeInstanceOf(Response);
    expect((secure as Response).headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect((secure as Response).headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect((secure as Response).headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect((insecure as Response).headers.has("strict-transport-security")).toBe(
      false,
    );
  });

  test("supports explicit policy overrides", async () => {
    const middleware = secureHeaders({
      contentSecurityPolicy: false,
      frameOptions: "SAMEORIGIN",
      hsts: false,
    });
    const response = (await middleware(context(), async () => new Response())) as Response;

    expect(response.headers.has("content-security-policy")).toBe(false);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.has("strict-transport-security")).toBe(false);
  });
});

describe("cors", () => {
  test("allows configured origins on normal requests", async () => {
    const middleware = cors({
      allowCredentials: true,
      exposeHeaders: ["x-request-id"],
      origin: ["https://app.test"],
    });
    const request = new Request("https://api.test/tasks", {
      headers: { origin: "https://app.test" },
    });
    const response = (await middleware(context(request), async () => ({
      ok: true,
    }))) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.test",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-request-id",
    );
    expect(response.headers.get("vary")).toContain("origin");
  });

  test("answers valid preflight without invoking the handler", async () => {
    let called = false;
    const middleware = cors({ origin: "https://app.test" });
    const request = new Request("https://api.test/tasks", {
      headers: {
        "access-control-request-headers": "content-type",
        "access-control-request-method": "POST",
        origin: "https://app.test",
      },
      method: "OPTIONS",
    });
    const response = (await middleware(context(request), async () => {
      called = true;
    })) as Response;

    expect(called).toBe(false);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  test("rejects denied preflights and ignores denied normal requests", async () => {
    const middleware = cors({ origin: "https://app.test" });
    const preflight = new Request("https://api.test", {
      headers: {
        "access-control-request-method": "POST",
        origin: "https://evil.test",
      },
      method: "OPTIONS",
    });
    const denied = (await middleware(
      context(preflight),
      async () => new Response("unsafe"),
    )) as Response;
    const normal = await middleware(
      context(
        new Request("https://api.test", {
          headers: { origin: "https://evil.test" },
        }),
      ),
      async () => "normal",
    );

    expect(denied.status).toBe(403);
    expect(normal).toBe("normal");
  });

  test("uses same-origin by default and prevents unsafe wildcard credentials", async () => {
    const sameOrigin = cors();
    const response = (await sameOrigin(
      context(
        new Request("https://api.test", {
          headers: { origin: "https://api.test" },
        }),
      ),
      async () => "ok",
    )) as Response;

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://api.test",
    );
    expect(() => cors({ allowCredentials: true, origin: "*" })).toThrow();
    expect(() => cors({ maxAge: -1 })).toThrow();
  });
});

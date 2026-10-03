import { describe, expect, test } from "bun:test";

import { csrf, SignedCookies } from "../src/index.ts";
import { context } from "./helpers.ts";

const OLD_SECRET = "old-secret-that-is-at-least-32-bytes-long";
const NEW_SECRET = "new-secret-that-is-at-least-32-bytes-long";

describe("SignedCookies", () => {
  test("signs values with secure defaults and detects tampering", async () => {
    const signer = SignedCookies.create({ secrets: NEW_SECRET });
    const cookies = new Bun.CookieMap();
    await signer.set(cookies, "session", "user-42");

    expect(await signer.get(cookies, "session")).toBe("user-42");
    expect(cookies.toSetCookieHeaders()[0]).toContain("HttpOnly");
    expect(cookies.toSetCookieHeaders()[0]).toContain("Secure");
    expect(cookies.toSetCookieHeaders()[0]).toContain("SameSite=Strict");

    const signed = cookies.get("session")!;
    const tampered = new Bun.CookieMap(
      `session=${signed.replace("s1.", "s1.A")}`,
    );
    expect(await signer.get(tampered, "session")).toBeNull();
  });

  test("supports secret rotation and binds signatures to cookie names", async () => {
    const oldSigner = SignedCookies.create({ secrets: OLD_SECRET });
    const rotated = SignedCookies.create({ secrets: [NEW_SECRET, OLD_SECRET] });
    const cookies = new Bun.CookieMap();
    await oldSigner.set(cookies, "session", "payload", { secure: false });

    expect(await rotated.get(cookies, "session")).toBe("payload");
    const transplanted = new Bun.CookieMap({ other: cookies.get("session")! });
    expect(await rotated.get(transplanted, "other")).toBeNull();
  });

  test("requires strong signing secrets and can delete cookies", () => {
    expect(() => SignedCookies.create({ secrets: "short" })).toThrow();

    const signer = SignedCookies.create({ secrets: NEW_SECRET });
    const cookies = new Bun.CookieMap({ session: "value" });
    signer.delete(cookies, "session");
    expect(cookies.toSetCookieHeaders()[0]).toContain(
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });
});

describe("csrf", () => {
  test("issues a signed token and accepts a matching header", async () => {
    const protection = csrf({ secrets: NEW_SECRET, secureCookie: false });
    const browserCookies = new Bun.CookieMap();
    const initial = context("http://example.test/form", {
      cookies: browserCookies,
    });

    await protection.middleware(initial, async () => "form");
    const token = await protection.token(initial);
    const signed = browserCookies.get("bolt_csrf")!;
    const submit = context(
      new Request("http://example.test/form", {
        headers: {
          cookie: `bolt_csrf=${signed}`,
          "x-csrf-token": token,
        },
        method: "POST",
      }),
    );
    const response = await protection.middleware(submit, async () => "saved");

    expect(response).toBe("saved");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("rejects missing, mismatched and tampered tokens", async () => {
    const protection = csrf({ secrets: NEW_SECRET, secureCookie: false });
    const missing = (await protection.middleware(
      context(
        new Request("http://example.test/form", { method: "POST" }),
      ),
      async () => "unsafe",
    )) as Response;

    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({
      error: {
        code: "CSRF_TOKEN_MISMATCH",
        message: "CSRF token is missing or invalid",
      },
    });

    const cookies = new Bun.CookieMap();
    const initial = context("http://example.test/form", { cookies });
    await protection.token(initial);
    const signed = cookies.get("bolt_csrf")!;
    const mismatched = (await protection.middleware(
      context(
        new Request("http://example.test/form", {
          headers: {
            cookie: `bolt_csrf=${signed}`,
            "x-csrf-token": "wrong-token",
          },
          method: "POST",
        }),
      ),
      async () => "unsafe",
    )) as Response;
    const tampered = (await protection.middleware(
      context(
        new Request("http://example.test/form", {
          headers: {
            cookie: `bolt_csrf=${signed}broken`,
            "x-csrf-token": await protection.token(initial),
          },
          method: "POST",
        }),
      ),
      async () => "unsafe",
    )) as Response;

    expect(mismatched.status).toBe(403);
    expect(tampered.status).toBe(403);
  });
});

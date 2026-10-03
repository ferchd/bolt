import type { SecurityContext } from "../src/index.ts";

export function context(
  input: string | Request = "https://example.test/",
  options: {
    readonly clientIp?: string | null;
    readonly cookies?: Bun.CookieMap;
  } = {},
): SecurityContext {
  const request = typeof input === "string" ? new Request(input) : input;

  return {
    clientIp: options.clientIp ?? "127.0.0.1",
    cookies:
      options.cookies ??
      new Bun.CookieMap(request.headers.get("cookie") ?? undefined),
    request,
  };
}

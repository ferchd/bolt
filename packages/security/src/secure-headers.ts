import { responseFrom, withHeaders } from "./response.ts";
import type { SecurityMiddleware } from "./types.ts";

export interface SecureHeadersOptions {
  readonly contentSecurityPolicy?: false | string;
  readonly crossOriginOpenerPolicy?: false | string;
  readonly frameOptions?: false | "DENY" | "SAMEORIGIN";
  readonly hsts?: false | string;
  readonly permissionsPolicy?: false | string;
  readonly referrerPolicy?: false | string;
}

const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function secureHeaders(
  options: SecureHeadersOptions = {},
): SecurityMiddleware {
  const headers = new Headers({
    "x-content-type-options": "nosniff",
  });
  setOptional(
    headers,
    "content-security-policy",
    options.contentSecurityPolicy,
    DEFAULT_CSP,
  );
  setOptional(
    headers,
    "cross-origin-opener-policy",
    options.crossOriginOpenerPolicy,
    "same-origin",
  );
  setOptional(headers, "x-frame-options", options.frameOptions, "DENY");
  setOptional(
    headers,
    "permissions-policy",
    options.permissionsPolicy,
    "camera=(), microphone=(), geolocation=()",
  );
  setOptional(
    headers,
    "referrer-policy",
    options.referrerPolicy,
    "no-referrer",
  );

  const hsts = options.hsts === undefined
    ? "max-age=31536000; includeSubDomains"
    : options.hsts;

  return async (context, next) => {
    const response = await responseFrom(next());
    const additions = new Headers(headers);

    if (hsts !== false && new URL(context.request.url).protocol === "https:") {
      additions.set("strict-transport-security", hsts);
    }

    return withHeaders(response, additions);
  };
}

function setOptional(
  headers: Headers,
  name: string,
  value: false | string | undefined,
  fallback: string,
): void {
  if (value !== false) {
    headers.set(name, value ?? fallback);
  }
}

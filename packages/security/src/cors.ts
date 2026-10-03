import { appendVary, responseFrom } from "./response.ts";
import type {
  MaybePromise,
  SecurityContext,
  SecurityMiddleware,
} from "./types.ts";

export type CorsOrigin =
  | string
  | readonly string[]
  | ((origin: string, context: SecurityContext) => MaybePromise<boolean>);

export interface CorsOptions {
  readonly allowCredentials?: boolean;
  readonly allowHeaders?: readonly string[];
  readonly allowMethods?: readonly string[];
  readonly exposeHeaders?: readonly string[];
  readonly maxAge?: number;
  readonly origin?: CorsOrigin;
}

const DEFAULT_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

const DEFAULT_HEADERS = ["authorization", "content-type", "x-csrf-token"];

export function cors(options: CorsOptions = {}): SecurityMiddleware {
  const credentials = options.allowCredentials ?? false;
  const originPolicy = options.origin;
  const allowMethods = joinTokens(options.allowMethods ?? DEFAULT_METHODS);
  const allowHeaders = joinTokens(options.allowHeaders ?? DEFAULT_HEADERS);
  const exposeHeaders = options.exposeHeaders
    ? joinTokens(options.exposeHeaders)
    : undefined;
  const maxAge = options.maxAge ?? 600;

  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new RangeError("CORS maxAge must be a non-negative safe integer");
  }

  if (credentials && containsWildcard(originPolicy)) {
    throw new TypeError(
      "CORS wildcard origins cannot be combined with credentials",
    );
  }

  return async (context, next) => {
    const requestOrigin = context.request.headers.get("origin");

    if (!requestOrigin) {
      return next();
    }

    const allowed = await isOriginAllowed(requestOrigin, context, originPolicy);
    const isPreflight =
      context.request.method === "OPTIONS" &&
      context.request.headers.has("access-control-request-method");

    if (!allowed) {
      return isPreflight
        ? Response.json(
            { error: { code: "CORS_ORIGIN_DENIED", message: "Origin denied" } },
            { status: 403 },
          )
        : next();
    }

    const response = isPreflight
      ? new Response(null, { status: 204 })
      : await responseFrom(next());
    const headers = new Headers(response.headers);

    headers.set(
      "access-control-allow-origin",
      containsWildcard(originPolicy) ? "*" : requestOrigin,
    );
    appendVary(headers, "Origin");

    if (credentials) {
      headers.set("access-control-allow-credentials", "true");
    }

    if (isPreflight) {
      headers.set("access-control-allow-methods", allowMethods);
      headers.set("access-control-allow-headers", allowHeaders);
      headers.set("access-control-max-age", String(maxAge));
      appendVary(headers, "Access-Control-Request-Method");
      appendVary(headers, "Access-Control-Request-Headers");
    } else if (exposeHeaders) {
      headers.set("access-control-expose-headers", exposeHeaders);
    }

    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

async function isOriginAllowed(
  origin: string,
  context: SecurityContext,
  policy: CorsOrigin | undefined,
): Promise<boolean> {
  if (typeof policy === "function") {
    return policy(origin, context);
  }

  if (Array.isArray(policy)) {
    return policy.includes("*") || policy.includes(origin);
  }

  if (typeof policy === "string") {
    return policy === "*" || policy === origin;
  }

  return origin === new URL(context.request.url).origin;
}

function containsWildcard(policy: CorsOrigin | undefined): boolean {
  return policy === "*" || (Array.isArray(policy) && policy.includes("*"));
}

function joinTokens(values: readonly string[]): string {
  const tokens = values.map((value) => value.trim()).filter(Boolean);

  if (tokens.length === 0) {
    throw new TypeError("CORS token lists cannot be empty");
  }

  return tokens.join(", ");
}

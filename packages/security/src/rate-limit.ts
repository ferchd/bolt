import { responseFrom } from "./response.ts";
import type {
  MaybePromise,
  SecurityContext,
  SecurityMiddleware,
} from "./types.ts";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  readonly key?: (
    context: SecurityContext,
  ) => MaybePromise<string | null | undefined>;
  readonly limit?: number;
  readonly maxEntries?: number;
  readonly windowMs?: number;
}

export interface RateLimitMiddleware extends SecurityMiddleware {
  readonly clear: () => void;
  readonly size: () => number;
}

export function rateLimit(
  options: RateLimitOptions = {},
): RateLimitMiddleware {
  const limit = positiveInteger(options.limit ?? 100, "limit");
  const windowMs = positiveInteger(options.windowMs ?? 60_000, "windowMs");
  const maxEntries = positiveInteger(options.maxEntries ?? 10_000, "maxEntries");
  const entries = new Map<string, RateLimitEntry>();
  let operations = 0;

  const middleware = async (
    context: SecurityContext,
    next: () => Promise<unknown>,
  ): Promise<Response> => {
    const now = Date.now();
    const key =
      (await options.key?.(context)) ?? context.clientIp ?? "unknown-client";

    operations += 1;
    if (operations % 100 === 0) {
      sweep(entries, now);
    }

    let entry = entries.get(key);

    if (!entry || entry.resetAt <= now) {
      if (!entry && entries.size >= maxEntries) {
        evict(entries, now);
      }

      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, limit - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));

    if (entry.count > limit) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests",
          },
        },
        {
          headers: rateHeaders(limit, remaining, entry.resetAt, resetSeconds),
          status: 429,
        },
      );
    }

    const response = await responseFrom(next());
    const headers = new Headers(response.headers);
    copyHeaders(
      headers,
      rateHeaders(limit, remaining, entry.resetAt),
    );

    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  return Object.assign(middleware, {
    clear: () => entries.clear(),
    size: () => entries.size,
  });
}

function rateHeaders(
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfter?: number,
): Headers {
  const headers = new Headers({
    "ratelimit-limit": String(limit),
    "ratelimit-remaining": String(remaining),
    "ratelimit-reset": String(Math.ceil(resetAt / 1_000)),
  });

  if (retryAfter !== undefined) {
    headers.set("retry-after", String(retryAfter));
  }

  return headers;
}

function copyHeaders(target: Headers, source: Headers): void {
  source.forEach((value, name) => target.set(name, value));
}

function sweep(entries: Map<string, RateLimitEntry>, now: number): void {
  for (const [key, entry] of entries) {
    if (entry.resetAt <= now) {
      entries.delete(key);
    }
  }
}

function evict(entries: Map<string, RateLimitEntry>, now: number): void {
  sweep(entries, now);

  if (entries.size === 0) {
    return;
  }

  const oldest = entries.keys().next().value;
  if (oldest !== undefined) {
    entries.delete(oldest);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Rate limit ${name} must be a positive safe integer`);
  }

  return value;
}

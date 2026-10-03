import { SignedCookies } from "./signed-cookies.ts";
import type {
  SecurityContext,
  SecurityMiddleware,
} from "./types.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const encoder = new TextEncoder();

export interface CsrfOptions {
  readonly cookieName?: string;
  readonly headerName?: string;
  readonly secrets: string | readonly string[];
  readonly secureCookie?: boolean;
}

export interface CsrfProtection {
  readonly middleware: SecurityMiddleware;
  readonly token: (context: SecurityContext) => Promise<string>;
}

export function csrf(options: CsrfOptions): CsrfProtection {
  const secureCookie = options.secureCookie ?? true;
  const cookieName =
    options.cookieName ?? (secureCookie ? "__Host-bolt_csrf" : "bolt_csrf");
  const headerName = options.headerName ?? "x-csrf-token";
  const cookies = SignedCookies.create({ secrets: options.secrets });

  if (!cookieName || !headerName) {
    throw new TypeError("CSRF cookie and header names cannot be empty");
  }

  const token = async (context: SecurityContext): Promise<string> => {
    const existing = await cookies.get(context.cookies, cookieName);
    if (existing) {
      return existing;
    }

    const created = randomToken();
    await cookies.set(context.cookies, cookieName, created, {
      secure: secureCookie,
    });
    return created;
  };

  const middleware: SecurityMiddleware = async (context, next) => {
    if (SAFE_METHODS.has(context.request.method)) {
      await token(context);
      return next();
    }

    const expected = await cookies.get(context.cookies, cookieName);
    const provided = context.request.headers.get(headerName);

    if (!expected || !provided || !constantTimeEqual(expected, provided)) {
      return Response.json(
        {
          error: {
            code: "CSRF_TOKEN_MISMATCH",
            message: "CSRF token is missing or invalid",
          },
        },
        { status: 403 },
      );
    }

    return next();
  };

  return Object.freeze({ middleware, token });
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

export interface SecurityContext {
  readonly clientIp: string | null;
  readonly cookies: Bun.CookieMap;
  readonly request: Request;
}

export type SecurityNext = () => Promise<unknown>;

export type SecurityMiddleware = (
  context: SecurityContext,
  next: SecurityNext,
) => unknown;

export type MaybePromise<Value> = Value | Promise<Value>;

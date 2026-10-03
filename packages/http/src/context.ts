import { RequestValidator } from "./request-validator.ts";
import type { Token } from "@bolt/container";

export interface RouteInfo {
  readonly method: string;
  readonly name?: string;
  readonly path: string;
}

export interface HttpContextOptions {
  readonly clientIp?: string | null;
  readonly logger?: HttpLogger;
  readonly params?: Readonly<Record<string, string>>;
  readonly requestId?: string;
  readonly services?: ServiceResolver;
  readonly route: RouteInfo;
  readonly timeout?: (seconds: number) => void;
}

export interface ServiceResolver {
  resolve<Value>(token: Token<Value>): Value;
}

export type HttpLogContext = Readonly<Record<string, unknown>>;

export interface HttpLogger {
  debug(message: string, context?: HttpLogContext): void;
  error(message: string, context?: HttpLogContext): void;
  info(message: string, context?: HttpLogContext): void;
  warn(message: string, context?: HttpLogContext): void;
}

export class HttpContext {
  readonly #url: URL;
  readonly #timeout?: (seconds: number) => void;

  public readonly clientIp: string | null;
  public readonly cookies: Bun.CookieMap;
  public readonly logger: HttpLogger;
  public readonly params: Readonly<Record<string, string>>;
  public readonly requestId: string;
  public readonly route: RouteInfo;
  public readonly services: ServiceResolver;
  public readonly validate: RequestValidator;

  public constructor(
    public readonly request: Request,
    options: HttpContextOptions,
  ) {
    this.#url = new URL(request.url);
    this.#timeout = options.timeout;
    this.clientIp = options.clientIp ?? null;
    this.cookies = getCookies(request);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.params = options.params ?? {};
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.route = options.route;
    this.services = options.services ?? UNAVAILABLE_SERVICES;
    this.validate = new RequestValidator(this);
  }

  public get query(): URLSearchParams {
    return this.#url.searchParams;
  }

  public get signal(): AbortSignal {
    return this.request.signal;
  }

  public get url(): URL {
    return this.#url;
  }

  public header(name: string): string | null {
    return this.request.headers.get(name);
  }

  public async json<Value = unknown>(): Promise<Value> {
    return (await this.request.json()) as Value;
  }

  public text(): Promise<string> {
    return this.request.text();
  }

  public formData(): Promise<FormData> {
    return this.request.formData();
  }

  public timeout(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 255) {
      throw new RangeError(
        "Request timeout must be a safe integer from 0 to 255 seconds",
      );
    }

    if (!this.#timeout) {
      throw new Error("Request timeout control is unavailable");
    }

    this.#timeout(seconds);
  }

  public resolve<Value>(token: Token<Value>): Value {
    return this.services.resolve(token);
  }
}

export type Next = () => Promise<unknown>;

function getCookies(request: Request): Bun.CookieMap {
  const cookies = Reflect.get(request, "cookies");

  if (cookies instanceof Bun.CookieMap) {
    return cookies;
  }

  return new Bun.CookieMap(request.headers.get("cookie") ?? undefined);
}

const NOOP_LOGGER: HttpLogger = Object.freeze({
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

const UNAVAILABLE_SERVICES: ServiceResolver = Object.freeze({
  resolve(): never {
    throw new Error("Application services are unavailable");
  },
});

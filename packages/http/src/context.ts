export interface RouteInfo {
  readonly method: string;
  readonly name?: string;
  readonly path: string;
}

export interface HttpContextOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly route: RouteInfo;
}

export class HttpContext {
  readonly #url: URL;

  public readonly cookies: Bun.CookieMap;
  public readonly params: Readonly<Record<string, string>>;
  public readonly route: RouteInfo;

  public constructor(
    public readonly request: Request,
    options: HttpContextOptions,
  ) {
    this.#url = new URL(request.url);
    this.cookies = getCookies(request);
    this.params = options.params ?? {};
    this.route = options.route;
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
}

export type Next = () => Promise<unknown>;

function getCookies(request: Request): Bun.CookieMap {
  const cookies = Reflect.get(request, "cookies");

  if (cookies instanceof Bun.CookieMap) {
    return cookies;
  }

  return new Bun.CookieMap(request.headers.get("cookie") ?? undefined);
}

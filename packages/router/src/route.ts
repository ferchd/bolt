import type {
  RouteHandler,
  RouteMethod,
  RouteMiddleware,
} from "./types.ts";

export class Route {
  #name?: string;
  readonly #middleware: RouteMiddleware[] = [];

  public constructor(
    public readonly method: RouteMethod,
    public readonly path: string,
    public readonly handler: RouteHandler,
  ) {}

  public get name(): string | undefined {
    return this.#name;
  }

  public get middleware(): readonly RouteMiddleware[] {
    return this.#middleware;
  }

  public as(name: string): this {
    this.#name = name;
    return this;
  }

  public use(middleware: RouteMiddleware | readonly RouteMiddleware[]): this {
    this.#middleware.push(...toMiddlewareArray(middleware));
    return this;
  }
}

export function toMiddlewareArray(
  middleware: RouteMiddleware | readonly RouteMiddleware[],
): readonly RouteMiddleware[] {
  return Array.isArray(middleware) ? middleware : [middleware];
}

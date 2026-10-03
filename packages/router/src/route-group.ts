import { toMiddlewareArray, type Route } from "./route.ts";
import type { StaticRoute } from "./static-route.ts";
import type { RouteMiddleware } from "./types.ts";

export type RoutableNode = Route | RouteGroup | StaticRoute;

export class RouteGroup {
  #pathPrefix = "";
  #namePrefix = "";
  readonly #middleware: RouteMiddleware[] = [];

  public constructor(public readonly nodes: readonly RoutableNode[]) {}

  public get pathPrefix(): string {
    return this.#pathPrefix;
  }

  public get namePrefix(): string {
    return this.#namePrefix;
  }

  public get middleware(): readonly RouteMiddleware[] {
    return this.#middleware;
  }

  public prefix(prefix: string): this {
    this.#pathPrefix = prefix;
    return this;
  }

  public as(prefix: string): this {
    this.#namePrefix = prefix;
    return this;
  }

  public use(middleware: RouteMiddleware | readonly RouteMiddleware[]): this {
    this.#middleware.push(...toMiddlewareArray(middleware));
    return this;
  }
}

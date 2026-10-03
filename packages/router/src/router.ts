import { joinPaths } from "./path.ts";
import { Route } from "./route.ts";
import { RouteGroup, type RoutableNode } from "./route-group.ts";
import { StaticRoute } from "./static-route.ts";
import type {
  CompiledRoute,
  RouteHandler,
  RouteMethod,
  RouteMiddleware,
  RouteTable,
} from "./types.ts";

export class Router {
  readonly #nodes: RoutableNode[] = [];
  readonly #scopes: RoutableNode[][] = [this.#nodes];

  private constructor() {}

  public static create(): Router {
    return new Router();
  }

  public delete(path: string, handler: RouteHandler): Route {
    return this.add("DELETE", path, handler);
  }

  public get(path: string, handler: RouteHandler): Route {
    return this.add("GET", path, handler);
  }

  public head(path: string, handler: RouteHandler): Route {
    return this.add("HEAD", path, handler);
  }

  public options(path: string, handler: RouteHandler): Route {
    return this.add("OPTIONS", path, handler);
  }

  public patch(path: string, handler: RouteHandler): Route {
    return this.add("PATCH", path, handler);
  }

  public post(path: string, handler: RouteHandler): Route {
    return this.add("POST", path, handler);
  }

  public put(path: string, handler: RouteHandler): Route {
    return this.add("PUT", path, handler);
  }

  public static(path: string, directory: string): StaticRoute {
    const route = new StaticRoute(path, directory);
    this.currentScope().push(route);
    return route;
  }

  public group(callback: () => void): RouteGroup {
    if (isAsyncFunction(callback)) {
      throw new TypeError("Router group callbacks must be synchronous");
    }

    const nodes: RoutableNode[] = [];
    this.#scopes.push(nodes);
    let result: unknown;

    try {
      result = callback();
    } finally {
      this.#scopes.pop();
    }

    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("Router group callbacks must be synchronous");
    }

    const group = new RouteGroup(nodes);
    this.currentScope().push(group);

    return group;
  }

  public compile(): RouteTable {
    const table: Record<string, MutableCompiledPath> = {};
    const names = new Set<string>();

    this.compileNodes(this.#nodes, table, names, {
      middleware: [],
      namePrefix: "",
      pathPrefix: "",
    });

    for (const methods of Object.values(table)) {
      Object.freeze(methods);
    }

    return Object.freeze(table);
  }

  private add(
    method: RouteMethod,
    path: string,
    handler: RouteHandler,
  ): Route {
    const route = new Route(method, path, handler);
    this.currentScope().push(route);
    return route;
  }

  private compileNodes(
    nodes: readonly RoutableNode[],
    table: Record<string, MutableCompiledPath>,
    names: Set<string>,
    context: CompilationContext,
  ): void {
    for (const node of nodes) {
      if (node instanceof RouteGroup) {
        this.compileNodes(node.nodes, table, names, {
          middleware: [...context.middleware, ...node.middleware],
          namePrefix: joinNames(context.namePrefix, node.namePrefix),
          pathPrefix: joinPaths(context.pathPrefix, node.pathPrefix),
        });
        continue;
      }

      if (node instanceof StaticRoute) {
        if (context.middleware.length > 0) {
          throw new TypeError(
            "Static routes cannot inherit middleware; use a dynamic route when access control is required",
          );
        }

        const path = toStaticPath(joinPaths(context.pathPrefix, node.path));

        if (table[path]) {
          throw new TypeError(`Duplicate route path: ${path}`);
        }

        table[path] = { directory: node.directory };
        continue;
      }

      const path = joinPaths(context.pathPrefix, node.path);
      const name = node.name
        ? joinNames(context.namePrefix, node.name)
        : undefined;
      const methods = (table[path] ??= {});

      if (methods.directory) {
        throw new TypeError(`Duplicate route path: ${path}`);
      }

      if (methods[node.method]) {
        throw new TypeError(`Duplicate route: ${node.method} ${path}`);
      }

      if (name && names.has(name)) {
        throw new TypeError(`Duplicate route name: ${name}`);
      }

      if (name) {
        names.add(name);
      }

      methods[node.method] = Object.freeze({
        handler: node.handler,
        method: node.method,
        middleware: Object.freeze([
          ...context.middleware,
          ...node.middleware,
        ]),
        ...(name ? { name } : {}),
        path,
      });
    }
  }

  private currentScope(): RoutableNode[] {
    const scope = this.#scopes.at(-1);

    if (!scope) {
      throw new Error("Router scope is unavailable");
    }

    return scope;
  }
}

type MutableCompiledPath = Partial<Record<RouteMethod, CompiledRoute>> & {
  directory?: string;
};

interface CompilationContext {
  readonly middleware: readonly RouteMiddleware[];
  readonly namePrefix: string;
  readonly pathPrefix: string;
}

function joinNames(...names: string[]): string {
  return names.filter(Boolean).join(".");
}

function toStaticPath(path: string): string {
  if (path === "/*" || path.endsWith("/*")) {
    return path;
  }

  return path === "/" ? "/*" : `${path}/*`;
}

function isAsyncFunction(callback: () => void): boolean {
  return callback.constructor.name === "AsyncFunction";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

import {
  HttpContext,
  toResponse,
  type Next,
} from "@bolt/http";
import type {
  CompiledRoute,
  ControllerHandler,
  ControllerReference,
  ControllerType,
  RouteMethod,
  RouteMiddleware,
  RouteMiddlewareCallback,
  RouteMiddlewareObject,
  RouteTable,
} from "@bolt/router";

type BunRouteHandler = (request: Request) => Promise<Response>;

type BunRouteTable = Record<
  string,
  | { readonly dir: string }
  | Partial<Record<RouteMethod, BunRouteHandler>>
>;

export function compileBunRoutes(routes: RouteTable): BunRouteTable {
  const compiled: BunRouteTable = {};

  for (const [path, methods] of Object.entries(routes)) {
    if (methods.directory) {
      compiled[path] = { dir: methods.directory };
      continue;
    }

    const compiledMethods: Partial<Record<RouteMethod, BunRouteHandler>> = {};

    for (const [method, route] of Object.entries(methods)) {
      if (method === "directory" || !route) {
        continue;
      }

      compiledMethods[method as RouteMethod] = createBunHandler(
        route as CompiledRoute,
      );
    }

    compiled[path] = compiledMethods;
  }

  return compiled;
}

function createBunHandler(route: CompiledRoute): BunRouteHandler {
  return async (request) => {
    const context = new HttpContext(request, {
      params: getRequestParams(request),
      route,
    });
    const result = await runMiddleware(route.middleware, context, () =>
      invokeRouteHandler(route, context),
    );

    return toResponse(result);
  };
}

async function runMiddleware(
  middleware: readonly RouteMiddleware[],
  context: HttpContext,
  handler: Next,
): Promise<unknown> {
  const dispatch = async (index: number): Promise<unknown> => {
    const current = middleware[index];

    if (!current) {
      return handler();
    }

    const { callback, receiver } = resolveMiddleware(current);
    let nextCalled = false;
    const next: Next = () => {
      if (nextCalled) {
        throw new Error("Middleware next() can only be called once");
      }

      nextCalled = true;
      return dispatch(index + 1);
    };

    return Reflect.apply(callback, receiver, [context, next]);
  };

  return dispatch(0);
}

function resolveMiddleware(middleware: RouteMiddleware): {
  callback: RouteMiddlewareCallback;
  receiver: RouteMiddlewareObject | undefined;
} {
  if (typeof middleware === "function") {
    return { callback: middleware, receiver: undefined };
  }

  return { callback: middleware.handle, receiver: middleware };
}

async function invokeRouteHandler(
  route: CompiledRoute,
  context: HttpContext,
): Promise<unknown> {
  const handler = route.handler;

  if (!isControllerHandler(handler)) {
    return Reflect.apply(handler, undefined, [context]);
  }

  const [reference, action] = handler;
  const controller = await resolveController(reference);
  const instance = Reflect.construct(controller, []);
  const method = Reflect.get(instance, action);

  if (typeof method !== "function") {
    throw new TypeError(`${controller.name}.${action} is not callable`);
  }

  return Reflect.apply(method, instance, [context]);
}

function isControllerHandler(
  handler: CompiledRoute["handler"],
): handler is ControllerHandler {
  return Array.isArray(handler);
}

async function resolveController(
  reference: ControllerReference,
): Promise<ControllerType> {
  if (isController(reference)) {
    return reference;
  }

  const imported = await reference();
  const controller = getDefaultExport(imported);

  if (!isController(controller)) {
    throw new TypeError("Lazy controller did not resolve to a class");
  }

  return controller;
}

function isController(value: unknown): value is ControllerType {
  return (
    typeof value === "function" &&
    Function.prototype.toString.call(value).startsWith("class ")
  );
}

function getDefaultExport(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "default" in value) {
    return value.default;
  }

  return value;
}

function getRequestParams(request: Request): Readonly<Record<string, string>> {
  if ("params" in request && typeof request.params === "object") {
    return request.params as Record<string, string>;
  }

  return {};
}

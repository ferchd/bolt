import {
  HttpError,
  HttpContext,
  toErrorResponse,
  toResponse,
  type Next,
  type RouteInfo,
} from "@bolt/http";
import { isToken, type Container } from "@bolt/container";
import type { Logger } from "@bolt/logger";
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

import type {
  ApplicationHooks,
  RequestOptions,
} from "./application.ts";

type BunRouteHandler = (
  request: Request,
  server: Bun.Server<undefined>,
) => Promise<Response>;

interface DispatcherOptions {
  readonly development: boolean;
  readonly hooks?: ApplicationHooks;
  readonly logger: Logger;
  readonly requests?: RequestOptions;
  readonly services: Container;
}

interface BunDispatcher {
  readonly fetch: BunRouteHandler;
  readonly routes: BunRouteTable;
}

type BunRouteTable = Record<
  string,
  | { readonly dir: string }
  | Partial<Record<RouteMethod, BunRouteHandler>>
>;

export function compileBunDispatcher(
  routes: RouteTable,
  options: DispatcherOptions,
): BunDispatcher {
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
        options,
      );
    }

    compiled[path] = compiledMethods;
  }

  return {
    fetch: createFallbackHandler(options),
    routes: compiled,
  };
}

function createBunHandler(
  route: CompiledRoute,
  options: DispatcherOptions,
): BunRouteHandler {
  return async (request, server) => {
    return handleRequest(request, server, route, options, (context) =>
      runMiddleware(route.middleware, context, () =>
        invokeRouteHandler(route, context, options.services),
      ),
    );
  };
}

function createFallbackHandler(
  options: DispatcherOptions,
): BunRouteHandler {
  return async (request, server) =>
    handleRequest(
      request,
      server,
      { method: request.method, path: "*" },
      options,
      () => new Response(null, { status: 404 }),
    );
}

async function handleRequest(
  request: Request,
  server: Bun.Server<undefined>,
  route: RouteInfo,
  options: DispatcherOptions,
  execute: (context: HttpContext) => unknown,
): Promise<Response> {
  const startedAt = performance.now();
  const idHeader = options.requests?.idHeader ?? "x-request-id";
  const requestId = resolveRequestId(request, idHeader);
  const logger = options.logger.child({ requestId });
  const context = new HttpContext(request, {
    clientIp: resolveClientIp(
      request,
      server,
      options.requests?.trustProxy ?? false,
    ),
    logger,
    params: getRequestParams(request),
    requestId,
    route,
    services: options.services,
    timeout: (seconds) => server.timeout(request, seconds),
  });
  let response: Response;

  try {
    await options.hooks?.onRequest?.(context);
    const result = await execute(context);
    response = toResponse(result);
  } catch (error) {
    await options.hooks?.onError?.(context, error);
    logRequestError(logger, error, route);
    response = toErrorResponse(error, {
      development: options.development,
    });
  }

  response = attachRequestId(response, idHeader, requestId);
  const durationMs = performance.now() - startedAt;
  await options.hooks?.onResponse?.(context, response, durationMs);

  if (options.requests?.accessLog ?? true) {
    logger.info("Request completed", {
      clientIp: context.clientIp,
      durationMs: Number(durationMs.toFixed(3)),
      method: request.method,
      route: route.name ?? route.path,
      status: response.status,
    });
  }

  return response;
}

function attachRequestId(
  response: Response,
  header: false | string,
  requestId: string,
): Response {
  if (header === false || response.headers.has(header)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set(header, requestId);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function logRequestError(
  logger: Logger,
  error: unknown,
  route: RouteInfo,
): void {
  if (error instanceof HttpError) {
    logger.warn("Request rejected", {
      code: error.code,
      route: route.name ?? route.path,
      status: error.status,
    });
    return;
  }

  logger.error("Unhandled request error", {
    error,
    route: route.name ?? route.path,
  });
}

function resolveClientIp(
  request: Request,
  server: Bun.Server<undefined>,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const forwarded = request.headers
      .get("x-forwarded-for")
      ?.split(",", 1)[0]
      ?.trim();

    if (forwarded) {
      return forwarded;
    }
  }

  return server.requestIP(request)?.address ?? null;
}

function resolveRequestId(
  request: Request,
  header: false | string,
): string {
  if (header !== false) {
    const provided = request.headers.get(header);

    if (provided && /^[a-zA-Z0-9._:-]{1,128}$/.test(provided)) {
      return provided;
    }
  }

  return crypto.randomUUID();
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
  services: Container,
): Promise<unknown> {
  const handler = route.handler;

  if (!isControllerHandler(handler)) {
    return Reflect.apply(handler, undefined, [context]);
  }

  const [reference, action] = handler;
  const instance = isToken(reference)
    ? services.resolve(reference)
    : Reflect.construct(await resolveController(reference), []);
  const method = Reflect.get(instance, action);

  if (typeof method !== "function") {
    const name = isToken(reference)
      ? reference.description
      : instance.constructor.name;
    throw new TypeError(`${name}.${action} is not callable`);
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
  if (isToken(reference)) {
    throw new TypeError("Controller tokens must be resolved by the container");
  }

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

import type { HttpContext, Next } from "@bolt/http";
import type { Token } from "@bolt/container";

export type ControllerType = abstract new (...args: never[]) => object;

export type LazyController = () => Promise<unknown>;

export type ControllerReference =
  | ControllerType
  | LazyController
  | Token<object>;

export type ControllerHandler = readonly [
  controller: ControllerReference,
  action: string,
];

export type RouteCallback = (context: HttpContext) => unknown;

export type RouteHandler = RouteCallback | ControllerHandler;

export type RouteMiddlewareCallback = (
  context: HttpContext,
  next: Next,
) => unknown;

export interface RouteMiddlewareObject {
  handle(context: HttpContext, next: Next): unknown;
}

export type RouteMiddleware = RouteMiddlewareCallback | RouteMiddlewareObject;

export type RouteMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export interface CompiledRoute {
  readonly method: RouteMethod;
  readonly path: string;
  readonly handler: RouteHandler;
  readonly name?: string;
  readonly middleware: readonly RouteMiddleware[];
}

export type CompiledPath = Readonly<
  Partial<Record<RouteMethod, CompiledRoute>> & {
    readonly directory?: string;
  }
>;

export type RouteTable = Readonly<
  Record<string, CompiledPath>
>;

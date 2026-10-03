export type ControllerType = abstract new (...args: never[]) => object;

export type LazyController = () => Promise<unknown>;

export type ControllerReference = ControllerType | LazyController;

export type ControllerHandler = readonly [
  controller: ControllerReference,
  action: string,
];

export type RouteCallback = (...args: never[]) => unknown;

export type RouteHandler = RouteCallback | ControllerHandler;

export type RouteMiddleware = object | ((...args: never[]) => unknown);

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

export type RouteTable = Readonly<
  Record<string, Readonly<Partial<Record<RouteMethod, CompiledRoute>>>>
>;

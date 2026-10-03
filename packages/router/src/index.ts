import { Router } from "./router.ts";

const router = Router.create();

export default router;

export { Route } from "./route.ts";

export { RouteGroup } from "./route-group.ts";

export { Router } from "./router.ts";

export { StaticRoute } from "./static-route.ts";

export type {
  CompiledRoute,
  CompiledPath,
  ControllerHandler,
  ControllerReference,
  ControllerType,
  LazyController,
  RouteCallback,
  RouteHandler,
  RouteMethod,
  RouteMiddleware,
  RouteMiddlewareCallback,
  RouteMiddlewareObject,
  RouteTable,
} from "./types.ts";

import { Router } from "./router.ts";

const router = Router.create();

export default router;

export { Route } from "./route.ts";

export { RouteGroup } from "./route-group.ts";

export { Router } from "./router.ts";

export type {
  CompiledRoute,
  ControllerHandler,
  ControllerReference,
  ControllerType,
  LazyController,
  RouteCallback,
  RouteHandler,
  RouteMethod,
  RouteMiddleware,
  RouteTable,
} from "./types.ts";

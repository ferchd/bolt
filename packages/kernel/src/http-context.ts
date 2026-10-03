import type { CompiledRoute } from "@bolt/router";

export interface HttpContext {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly route: CompiledRoute;
}

export type Next = () => Promise<unknown>;

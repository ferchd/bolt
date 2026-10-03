import type { BoltApplication } from "./application.ts";

export type ApplicationState =
  | "running"
  | "starting"
  | "stopped"
  | "stopping";

export type MaybePromise<Value> = Value | PromiseLike<Value>;

export interface ApplicationService {
  start?(application: BoltApplication): MaybePromise<void>;
  stop?(application: BoltApplication): MaybePromise<void>;
}

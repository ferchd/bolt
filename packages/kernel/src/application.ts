import { HttpError, toErrorResponse } from "@bolt/http";
import logger, { type Logger } from "@bolt/logger";
import router, { type Router } from "@bolt/router";

import { compileBunRoutes } from "./dispatcher.ts";
import type {
  ApplicationService,
  ApplicationState,
} from "./lifecycle.ts";

export interface ApplicationOptions {
  readonly development?: Bun.Serve.Development;
  readonly hostname?: string;
  readonly logger?: Logger;
  readonly port?: number;
  readonly router?: Router;
}

export class BoltApplication {
  readonly #options: ApplicationOptions;
  readonly #services: ApplicationService[] = [];
  #server?: Bun.Server<undefined>;
  #startOperation?: Promise<this>;
  #state: ApplicationState = "stopped";
  #stopOperation?: Promise<void>;

  public readonly logger: Logger;

  private constructor(options: ApplicationOptions) {
    this.#options = options;
    this.logger = options.logger ?? logger;
  }

  public static create(options: ApplicationOptions = {}): BoltApplication {
    return new BoltApplication(options);
  }

  public get isRunning(): boolean {
    return this.#state === "running";
  }

  public get state(): ApplicationState {
    return this.#state;
  }

  public get port(): number {
    const port = this.getServer().port;

    if (port === undefined) {
      throw new Error("Bolt is not listening on a TCP port");
    }

    return port;
  }

  public get url(): URL {
    return this.getServer().url;
  }

  public use(service: ApplicationService): this {
    if (this.#state !== "stopped") {
      throw new Error("Services can only be registered while Bolt is stopped");
    }

    this.#services.push(service);
    return this;
  }

  public start(): Promise<this> {
    if (this.#state === "running") {
      return Promise.resolve(this);
    }

    if (this.#state === "starting") {
      return this.#startOperation ?? Promise.resolve(this);
    }

    if (this.#state === "stopping") {
      return (this.#stopOperation ?? Promise.resolve()).then(() => this.start());
    }

    this.#state = "starting";
    const operation = this.startApplication();
    this.#startOperation = operation;
    operation.then(
      () => this.clearStartOperation(operation),
      () => this.clearStartOperation(operation),
    );

    return operation;
  }

  public stop(): Promise<void> {
    if (this.#state === "stopped") {
      return Promise.resolve();
    }

    if (this.#state === "stopping") {
      return this.#stopOperation ?? Promise.resolve();
    }

    if (this.#state === "starting") {
      return (this.#startOperation ?? Promise.resolve(this)).then(() =>
        this.stop(),
      );
    }

    this.#state = "stopping";
    const operation = this.stopApplication();
    this.#stopOperation = operation;
    operation.then(
      () => this.clearStopOperation(operation),
      () => this.clearStopOperation(operation),
    );

    return operation;
  }

  private async startApplication(): Promise<this> {
    const started: ApplicationService[] = [];

    try {
      for (const service of this.#services) {
        await service.start?.(this);
        started.push(service);
      }

      this.#server = Bun.serve({
        development: this.#options.development,
        error: (error) => this.handleError(error),
        fetch: () => new Response(null, { status: 404 }),
        hostname: this.#options.hostname,
        port: this.#options.port,
        routes: compileBunRoutes((this.#options.router ?? router).compile()),
      });
      this.#state = "running";
      this.logger.info("Application started", { url: this.url.href });
    } catch (error) {
      const rollbackErrors: unknown[] = [];

      try {
        await this.stopServer();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }

      rollbackErrors.push(...(await this.stopServices(started)));
      this.#state = "stopped";

      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Bolt failed to start and rollback cleanly",
        );
      }

      throw error;
    }

    return this;
  }

  private async stopApplication(): Promise<void> {
    const errors: unknown[] = [];

    try {
      await this.stopServer();
    } catch (error) {
      errors.push(error);
    }

    errors.push(...(await this.stopServices(this.#services)));
    this.#state = "stopped";

    if (errors.length > 0) {
      throw new AggregateError(errors, "Bolt failed to stop cleanly");
    }

    this.logger.info("Application stopped");
  }

  private clearStartOperation(operation: Promise<this>): void {
    if (this.#startOperation === operation) {
      this.#startOperation = undefined;
    }
  }

  private clearStopOperation(operation: Promise<void>): void {
    if (this.#stopOperation === operation) {
      this.#stopOperation = undefined;
    }
  }

  private handleError(error: Error): Response {
    if (error instanceof HttpError) {
      this.logger.warn("Request rejected", {
        code: error.code,
        status: error.status,
      });
    } else {
      this.logger.error("Unhandled request error", { error });
    }

    return toErrorResponse(error, {
      development: isDevelopment(this.#options.development),
    });
  }

  private getServer(): Bun.Server<undefined> {
    if (!this.#server) {
      throw new Error("Bolt has not been started");
    }

    return this.#server;
  }

  private async stopServer(): Promise<void> {
    const server = this.#server;

    if (!server) {
      return;
    }

    this.#server = undefined;
    await server.stop();
  }

  private async stopServices(
    services: readonly ApplicationService[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];

    for (const service of services.toReversed()) {
      try {
        await service.stop?.(this);
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }
}

function isDevelopment(
  development: Bun.Serve.Development | undefined,
): boolean {
  if (typeof development === "boolean") {
    return development;
  }

  if (development !== undefined) {
    return true;
  }

  return Bun.env.NODE_ENV !== "production";
}

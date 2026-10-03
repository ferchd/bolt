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
  #state: ApplicationState = "stopped";

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

  public async start(): Promise<this> {
    if (this.#state === "running") {
      return this;
    }

    if (this.#state !== "stopped") {
      throw new Error(`Cannot start Bolt while it is ${this.#state}`);
    }

    this.#state = "starting";
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
      await this.stopServer();
      const rollbackErrors = await this.stopServices(started);
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

  public async stop(): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }

    if (this.#state !== "running") {
      throw new Error(`Cannot stop Bolt while it is ${this.#state}`);
    }

    this.#state = "stopping";
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

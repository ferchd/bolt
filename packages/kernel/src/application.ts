import {
  HttpError,
  toErrorResponse,
  type HttpContext,
} from "@bolt/http";
import {
  Container,
  type Provider as ContainerProvider,
} from "@bolt/container";
import logger, { type Logger } from "@bolt/logger";
import router, { type Router } from "@bolt/router";

import { compileBunDispatcher } from "./dispatcher.ts";
import type {
  ApplicationService,
  ApplicationState,
} from "./lifecycle.ts";

export interface ApplicationOptions {
  readonly bindings?: readonly ContainerProvider<any, any>[];
  readonly development?: Bun.Serve.Development;
  readonly hostname?: string;
  readonly hooks?: ApplicationHooks;
  readonly logger?: Logger;
  readonly port?: number;
  readonly providers?: readonly ApplicationProvider[];
  readonly requests?: RequestOptions;
  readonly router?: Router;
  readonly server?: ServerOptions;
  readonly shutdownSignals?: false | readonly NodeJS.Signals[];
}

export interface ApplicationProvider {
  boot?(application: BoltApplication): void | PromiseLike<void>;
  register(container: Container): void;
  shutdown?(application: BoltApplication): void | PromiseLike<void>;
}

export interface ApplicationHooks {
  readonly onError?: (
    context: HttpContext,
    error: unknown,
  ) => void | PromiseLike<void>;
  readonly onRequest?: (context: HttpContext) => void | PromiseLike<void>;
  readonly onResponse?: (
    context: HttpContext,
    response: Response,
    durationMs: number,
  ) => void | PromiseLike<void>;
}

export interface RequestOptions {
  readonly accessLog?: boolean;
  readonly idHeader?: false | string;
  readonly trustProxy?: boolean;
}

export interface ServerOptions {
  readonly idleTimeout?: number;
  readonly ipv6Only?: boolean;
  readonly maxRequestBodySize?: number;
  readonly reusePort?: boolean;
  readonly tls?: Bun.TLSOptions | readonly Bun.TLSOptions[];
}

export class BoltApplication {
  #container: Container;
  readonly #options: ApplicationOptions;
  readonly #services: ApplicationService[] = [];
  #server?: Bun.Server<undefined>;
  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();
  #startOperation?: Promise<this>;
  #state: ApplicationState = "stopped";
  #stopOperation?: Promise<void>;

  public readonly logger: Logger;

  private constructor(options: ApplicationOptions) {
    validateRequestOptions(options.requests);
    validateServerOptions(options.server);
    this.#options = options;
    this.logger = options.logger ?? logger;
    this.#container = this.createContainer();
  }

  public static create(options: ApplicationOptions = {}): BoltApplication {
    return new BoltApplication(options);
  }

  public get isRunning(): boolean {
    return this.#state === "running";
  }

  public get container(): Container {
    return this.#container;
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
      return this.#container.dispose();
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
    if (this.#container.state === "disposed") {
      this.#container = this.createContainer();
    }

    const booted: ApplicationProvider[] = [];
    const started: ApplicationService[] = [];

    try {
      const dispatcher = compileBunDispatcher(
        (this.#options.router ?? router).compile(),
        {
          development: isDevelopment(this.#options.development),
          hooks: this.#options.hooks,
          logger: this.logger,
          requests: this.#options.requests,
          services: this.#container,
        },
      );
      this.registerShutdownSignals();

      for (const service of this.#services) {
        await service.start?.(this);
        started.push(service);
      }

      for (const provider of this.#options.providers ?? []) {
        await provider.boot?.(this);
        booted.push(provider);
      }

      this.#server = Bun.serve({
        development: this.#options.development,
        error: (error) => this.handleError(error),
        fetch: dispatcher.fetch,
        hostname: this.#options.hostname,
        idleTimeout:
          this.#options.server?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
        ipv6Only: this.#options.server?.ipv6Only,
        maxRequestBodySize:
          this.#options.server?.maxRequestBodySize ??
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        port: this.#options.port,
        reusePort: this.#options.server?.reusePort,
        routes: dispatcher.routes,
        tls: this.#options.server?.tls as
          | Bun.TLSOptions
          | Bun.TLSOptions[]
          | undefined,
      });
      this.#state = "running";
      this.logger.info("Application started", { url: this.url.href });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      this.removeShutdownSignals();

      try {
        await this.stopServer();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }

      rollbackErrors.push(...(await this.shutdownProviders(booted)));
      rollbackErrors.push(...(await this.stopServices(started)));

      try {
        await this.#container.dispose();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
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
    this.removeShutdownSignals();

    try {
      await this.stopServer();
    } catch (error) {
      errors.push(error);
    }

    errors.push(
      ...(await this.shutdownProviders(this.#options.providers ?? [])),
    );
    errors.push(...(await this.stopServices(this.#services)));

    try {
      await this.#container.dispose();
    } catch (error) {
      errors.push(error);
    }
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

  private createContainer(): Container {
    const container = Container.create(...(this.#options.bindings ?? []));

    for (const provider of this.#options.providers ?? []) {
      provider.register(container);
    }

    return container;
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

  private registerShutdownSignals(): void {
    const signals = this.#options.shutdownSignals ?? DEFAULT_SHUTDOWN_SIGNALS;

    if (signals === false) {
      return;
    }

    for (const signal of new Set(signals)) {
      const handler = () => {
        this.logger.info("Shutdown signal received", { signal });
        void this.stop().catch((error: unknown) => {
          this.logger.error("Graceful shutdown failed", { error, signal });
          process.exitCode = 1;
        });
      };

      process.on(signal, handler);
      this.#signalHandlers.set(signal, handler);
    }
  }

  private removeShutdownSignals(): void {
    for (const [signal, handler] of this.#signalHandlers) {
      process.off(signal, handler);
    }

    this.#signalHandlers.clear();
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

  private async shutdownProviders(
    providers: readonly ApplicationProvider[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];

    for (const provider of providers.toReversed()) {
      try {
        await provider.shutdown?.(this);
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }
}

const DEFAULT_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const DEFAULT_IDLE_TIMEOUT = 10;
const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024;

function validateRequestOptions(options: RequestOptions | undefined): void {
  if (!options || options.idHeader === undefined || options.idHeader === false) {
    return;
  }

  try {
    new Headers({ [options.idHeader]: "request-id" });
  } catch (error) {
    throw new TypeError("Request idHeader must be a valid HTTP header name", {
      cause: error,
    });
  }
}

function validateServerOptions(options: ServerOptions | undefined): void {
  if (!options) {
    return;
  }

  if (
    options.idleTimeout !== undefined &&
    (!Number.isSafeInteger(options.idleTimeout) ||
      options.idleTimeout < 0 ||
      options.idleTimeout > 255)
  ) {
    throw new RangeError(
      "Server idleTimeout must be a safe integer from 0 to 255 seconds",
    );
  }

  if (
    options.maxRequestBodySize !== undefined &&
    (!Number.isSafeInteger(options.maxRequestBodySize) ||
      options.maxRequestBodySize <= 0)
  ) {
    throw new RangeError(
      "Server maxRequestBodySize must be a positive safe integer",
    );
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

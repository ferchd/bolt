import {
  DependencyCycleError,
  ProviderNotFoundError,
} from "./errors.ts";
import type {
  ClassProvider,
  FactoryProvider,
  Provider,
  ResolvedDependencies,
} from "./provider.ts";
import type { Token } from "./token.ts";

export type ContainerState = "active" | "disposed" | "disposing";
export type MaybePromise<Value> = Value | PromiseLike<Value>;

export interface ContainerResource {
  dispose?(): MaybePromise<void>;
  stop?(): MaybePromise<void>;
  [Symbol.asyncDispose]?(): PromiseLike<void>;
  [Symbol.dispose]?(): void;
}

type Cleanup = () => MaybePromise<void>;
type AnyProvider = Provider<any, any>;

export class Container {
  readonly #providers = new Map<Token<unknown>, AnyProvider>();
  readonly #resolutionStack: Token<unknown>[] = [];
  readonly #resources: ContainerResource[] = [];
  readonly #singletons = new Map<Token<unknown>, unknown>();
  readonly #trackedResources = new WeakSet<object>();
  #disposePromise?: Promise<void>;
  #state: ContainerState = "active";

  private constructor() {}

  public static create(...providers: readonly AnyProvider[]): Container {
    return new Container().register(...providers);
  }

  public get state(): ContainerState {
    return this.#state;
  }

  public has(token: Token<unknown>): boolean {
    return this.#providers.has(token);
  }

  public register(...providers: readonly AnyProvider[]): this {
    this.assertActive("register providers");

    const registeredTokens = new Set(this.#providers.keys());

    for (const provider of providers) {
      if (registeredTokens.has(provider.token)) {
        throw new Error(
          `A provider is already registered for ${provider.token.description}`,
        );
      }

      registeredTokens.add(provider.token);
    }

    for (const provider of providers) {
      this.#providers.set(provider.token, provider);
    }

    return this;
  }

  public resolve<Value>(token: Token<Value>): Value {
    this.assertActive("resolve dependencies");

    if (this.#singletons.has(token)) {
      return this.#singletons.get(token) as Value;
    }

    const provider = this.#providers.get(token) as AnyProvider | undefined;

    if (!provider) {
      throw new ProviderNotFoundError(token);
    }

    const cycleStart = this.#resolutionStack.indexOf(token);

    if (cycleStart !== -1) {
      throw new DependencyCycleError([
        ...this.#resolutionStack.slice(cycleStart),
        token,
      ]);
    }

    this.#resolutionStack.push(token);

    try {
      const value = this.instantiate<Value>(provider);

      if (provider.kind === "value" || provider.lifetime === "singleton") {
        this.#singletons.set(token, value);
      }

      this.track(value);
      return value;
    } finally {
      this.#resolutionStack.pop();
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    if (this.#state === "disposed") {
      return Promise.resolve();
    }

    this.#state = "disposing";
    this.#disposePromise = this.disposeResources();
    return this.#disposePromise;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  private assertActive(action: string): void {
    if (this.#state !== "active") {
      throw new Error(`Cannot ${action} after container disposal has started`);
    }
  }

  private async disposeResources(): Promise<void> {
    const errors: unknown[] = [];

    try {
      for (let index = this.#resources.length - 1; index >= 0; index -= 1) {
        const resource = this.#resources[index];

        if (!resource) {
          continue;
        }

        const cleanup = cleanupFor(resource);

        if (!cleanup) {
          continue;
        }

        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.#resources.length = 0;
      this.#singletons.clear();
      this.#state = "disposed";
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Container resources failed to dispose");
    }
  }

  private instantiate<Value>(provider: AnyProvider): Value {
    if (provider.kind === "value") {
      return provider.value as Value;
    }

    const dependencies = provider.dependencies.map(
      (dependency: Token<unknown>) => this.resolve(dependency),
    ) as ResolvedDependencies<typeof provider.dependencies>;

    if (provider.kind === "factory") {
      return invokeFactory(provider, dependencies) as Value;
    }

    return instantiateClass(provider, dependencies) as Value;
  }

  private track(value: unknown): void {
    if (!isContainerResource(value) || this.#trackedResources.has(value)) {
      return;
    }

    this.#trackedResources.add(value);
    this.#resources.push(value);
  }
}

function cleanupFor(resource: ContainerResource): Cleanup | undefined {
  if (typeof resource[Symbol.asyncDispose] === "function") {
    return () => resource[Symbol.asyncDispose]?.();
  }

  if (typeof resource[Symbol.dispose] === "function") {
    return () => resource[Symbol.dispose]?.();
  }

  if (typeof resource.dispose === "function") {
    return () => resource.dispose?.();
  }

  if (typeof resource.stop === "function") {
    return () => resource.stop?.();
  }

  return undefined;
}

function instantiateClass<Value>(
  provider: ClassProvider<Value>,
  dependencies: ResolvedDependencies<typeof provider.dependencies>,
): Value {
  return new provider.useClass(...dependencies);
}

function invokeFactory<Value>(
  provider: FactoryProvider<Value>,
  dependencies: ResolvedDependencies<typeof provider.dependencies>,
): Value {
  return provider.factory(...dependencies);
}

function isContainerResource(value: unknown): value is ContainerResource & object {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }

  const resource = value as ContainerResource;

  return (
    typeof resource[Symbol.asyncDispose] === "function" ||
    typeof resource[Symbol.dispose] === "function" ||
    typeof resource.dispose === "function" ||
    typeof resource.stop === "function"
  );
}

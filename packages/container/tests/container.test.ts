import { describe, expect, test } from "bun:test";

import {
  Container,
  DependencyCycleError,
  ProviderNotFoundError,
  createToken,
  isToken,
  provideClass,
  provideFactory,
  provideValue,
} from "../src/index.ts";

describe("Container", () => {
  test("resolves value, factory, and class providers with typed dependencies", () => {
    const port = createToken<number>("port");
    const url = createToken<string>("url");
    const client = createToken<Client>("client");

    class Client {
      public constructor(
        public readonly baseUrl: string,
        public readonly retries: number,
      ) {}
    }

    const container = Container.create(
      provideValue(port, 3000),
      provideFactory(url, [port], (resolvedPort) => `http://localhost:${resolvedPort}`),
      provideClass(client, [url, port], Client),
    );

    expect(container.resolve(client)).toEqual(
      new Client("http://localhost:3000", 3000),
    );
    expect(container.has(url)).toBe(true);
  });

  test("caches singleton providers by default", () => {
    const value = createToken<{ readonly id: number }>("value");
    let creations = 0;
    const container = Container.create(
      provideFactory(value, [], () => ({ id: ++creations })),
    );

    expect(container.resolve(value)).toBe(container.resolve(value));
    expect(creations).toBe(1);
  });

  test("creates a new value for transient providers", () => {
    const value = createToken<{ readonly id: number }>("value");
    let creations = 0;
    const container = Container.create(
      provideFactory(value, [], () => ({ id: ++creations }), {
        lifetime: "transient",
      }),
    );

    expect(container.resolve(value)).not.toBe(container.resolve(value));
    expect(creations).toBe(2);
  });

  test("reports missing providers", () => {
    const missing = createToken<string>("missing configuration");
    const container = Container.create();

    expect(() => container.resolve(missing)).toThrow(ProviderNotFoundError);
    expect(() => container.resolve(missing)).toThrow(
      "No provider is registered for missing configuration",
    );
  });

  test("rejects duplicate providers atomically", () => {
    const first = createToken<number>("first");
    const second = createToken<number>("second");
    const container = Container.create(provideValue(first, 1));

    expect(() =>
      container.register(provideValue(second, 2), provideValue(first, 3)),
    ).toThrow("A provider is already registered for first");
    expect(container.has(second)).toBe(false);
  });

  test("detects dependency cycles and exposes their path", () => {
    const first = createToken<string>("first");
    const second = createToken<string>("second");
    const container = Container.create(
      provideFactory(first, [second], (value) => value),
      provideFactory(second, [first], (value) => value),
    );

    try {
      container.resolve(first);
      throw new Error("Expected dependency resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).message).toBe(
        "Dependency cycle detected: first -> second -> first",
      );
      expect(
        (error as DependencyCycleError).path.map(({ description }) => description),
      ).toEqual(["first", "second", "first"]);
    }
  });

  test("disposes resources once in reverse creation order", async () => {
    const calls: string[] = [];
    const dependency = createToken<{ stop(): void }>("dependency");
    const service = createToken<{ dispose(): Promise<void> }>("service");
    const container = Container.create(
      provideFactory(dependency, [], () => ({
        stop() {
          calls.push("dependency");
        },
      })),
      provideFactory(service, [dependency], () => ({
        async dispose() {
          await Bun.sleep(1);
          calls.push("service");
        },
      })),
    );

    container.resolve(service);
    await Promise.all([container.dispose(), container.dispose()]);

    expect(calls).toEqual(["service", "dependency"]);
    expect(container.state).toBe("disposed");
  });

  test("tracks every transient resource without disposing shared values twice", async () => {
    const calls: number[] = [];
    const resource = createToken<{ dispose(): void }>("resource");
    const shared = {
      dispose() {
        calls.push(0);
      },
    };
    const sharedAlias = createToken<typeof shared>("same resource");
    let id = 0;
    const transient = Container.create(
      provideFactory(
        resource,
        [],
        () => {
          const resourceId = ++id;

          return {
            dispose() {
              calls.push(resourceId);
            },
          };
        },
        { lifetime: "transient" },
      ),
    );
    const sharedContainer = Container.create(
      provideValue(resource, shared),
      provideValue(sharedAlias, shared),
    );

    transient.resolve(resource);
    transient.resolve(resource);
    sharedContainer.resolve(resource);
    sharedContainer.resolve(sharedAlias);
    await transient.dispose();
    await sharedContainer.dispose();

    expect(calls).toEqual([2, 1, 0]);
  });

  test("continues cleanup and aggregates disposal failures", async () => {
    const calls: string[] = [];
    const first = createToken<{ stop(): void }>("first");
    const second = createToken<{ stop(): void }>("second");
    const container = Container.create(
      provideFactory(first, [], () => ({
        stop() {
          calls.push("first");
          throw new Error("first failed");
        },
      })),
      provideFactory(second, [], () => ({
        stop() {
          calls.push("second");
          throw new Error("second failed");
        },
      })),
    );

    container.resolve(first);
    container.resolve(second);

    try {
      await container.dispose();
      throw new Error("Expected disposal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
    }

    expect(calls).toEqual(["second", "first"]);
    expect(container.state).toBe("disposed");
  });

  test("prevents registration and resolution once disposal starts", async () => {
    const value = createToken<number>("value");
    const container = Container.create(provideValue(value, 1));

    const disposal = container.dispose();

    expect(() => container.resolve(value)).toThrow(
      "Cannot resolve dependencies after container disposal has started",
    );
    expect(() => container.register()).toThrow(
      "Cannot register providers after container disposal has started",
    );
    await disposal;
  });
});

describe("tokens", () => {
  test("require meaningful descriptions", () => {
    expect(() => createToken("   ")).toThrow(
      "Container token descriptions cannot be empty",
    );
  });

  test("remain distinct when descriptions match", () => {
    expect(createToken("service")).not.toBe(createToken("service"));
  });

  test("identifies tokens without accepting arbitrary values", () => {
    expect(isToken(createToken("service"))).toBe(true);
    expect(isToken(Symbol("service"))).toBe(false);
    expect(isToken({ description: "service" })).toBe(false);
  });
});

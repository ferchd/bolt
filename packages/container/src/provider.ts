import type { Token } from "./token.ts";

export type Lifetime = "singleton" | "transient";
export type DependencyTokens = readonly Token<unknown>[];

export type ResolvedDependencies<Dependencies extends DependencyTokens> = {
  -readonly [Index in keyof Dependencies]: Dependencies[Index] extends Token<
    infer Value
  >
    ? Value
    : never;
};

type ProviderFactory<Value, Dependencies extends DependencyTokens> = {
  bivarianceHack(...dependencies: ResolvedDependencies<Dependencies>): Value;
}["bivarianceHack"];

export interface ValueProvider<Value> {
  readonly kind: "value";
  readonly token: Token<Value>;
  readonly value: Value;
}

export interface FactoryProvider<
  Value,
  Dependencies extends DependencyTokens = DependencyTokens,
> {
  readonly dependencies: Dependencies;
  readonly factory: ProviderFactory<Value, Dependencies>;
  readonly kind: "factory";
  readonly lifetime: Lifetime;
  readonly token: Token<Value>;
}

export interface ClassProvider<
  Value,
  Dependencies extends DependencyTokens = DependencyTokens,
> {
  readonly dependencies: Dependencies;
  readonly kind: "class";
  readonly lifetime: Lifetime;
  readonly token: Token<Value>;
  readonly useClass: new (
    ...dependencies: ResolvedDependencies<Dependencies>
  ) => Value;
}

export type Provider<
  Value = unknown,
  Dependencies extends DependencyTokens = DependencyTokens,
> =
  | ClassProvider<Value, Dependencies>
  | FactoryProvider<Value, Dependencies>
  | ValueProvider<Value>;

export interface ProviderOptions {
  readonly lifetime?: Lifetime;
}

export function provideValue<Value>(
  token: Token<Value>,
  value: Value,
): ValueProvider<Value> {
  return Object.freeze({ kind: "value", token, value });
}

export function provideFactory<
  Value,
  const Dependencies extends DependencyTokens,
>(
  token: Token<Value>,
  dependencies: Dependencies,
  factory: (...dependencies: ResolvedDependencies<Dependencies>) => Value,
  options: ProviderOptions = {},
): FactoryProvider<Value, Dependencies> {
  return Object.freeze({
    dependencies: Object.freeze([...dependencies]) as unknown as Dependencies,
    factory,
    kind: "factory",
    lifetime: resolveLifetime(options.lifetime),
    token,
  });
}

export function provideClass<
  Value,
  const Dependencies extends DependencyTokens,
>(
  token: Token<Value>,
  dependencies: Dependencies,
  useClass: new (...dependencies: ResolvedDependencies<Dependencies>) => Value,
  options: ProviderOptions = {},
): ClassProvider<Value, Dependencies> {
  return Object.freeze({
    dependencies: Object.freeze([...dependencies]) as unknown as Dependencies,
    kind: "class",
    lifetime: resolveLifetime(options.lifetime),
    token,
    useClass,
  });
}

function resolveLifetime(lifetime: Lifetime | undefined): Lifetime {
  return lifetime ?? "singleton";
}

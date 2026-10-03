import type { Token } from "./token.ts";

export class ContainerError extends Error {
  public override readonly name: string = "ContainerError";
}

export class ProviderNotFoundError extends ContainerError {
  public override readonly name = "ProviderNotFoundError";
  public readonly token: Token<unknown>;

  public constructor(token: Token<unknown>) {
    super(`No provider is registered for ${token.description}`);
    this.token = token;
  }
}

export class DependencyCycleError extends ContainerError {
  public override readonly name = "DependencyCycleError";
  public readonly path: readonly Token<unknown>[];

  public constructor(path: readonly Token<unknown>[]) {
    super(
      `Dependency cycle detected: ${path
        .map(({ description }) => description)
        .join(" -> ")}`,
    );
    this.path = Object.freeze([...path]);
  }
}

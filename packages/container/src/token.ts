const tokenType: unique symbol = Symbol("bolt.container.tokenType");

export interface Token<Value> {
  readonly description: string;
  readonly id: symbol;
  readonly [tokenType]?: Value;
}

export function createToken<Value>(description: string): Token<Value> {
  const normalizedDescription = description.trim();

  if (normalizedDescription.length === 0) {
    throw new TypeError("Container token descriptions cannot be empty");
  }

  return Object.freeze({
    description: normalizedDescription,
    id: Symbol(normalizedDescription),
  });
}

export function isToken(value: unknown): value is Token<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "description" in value &&
    typeof value.description === "string" &&
    "id" in value &&
    typeof value.id === "symbol"
  );
}

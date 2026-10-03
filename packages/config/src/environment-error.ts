export class EnvironmentError extends Error {
  public override readonly name = "EnvironmentError";

  public constructor(
    public readonly variable: string,
    reason: string,
  ) {
    super(`Invalid environment variable ${variable}: ${reason}`);
  }
}

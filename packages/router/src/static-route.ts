export class StaticRoute {
  public constructor(
    public readonly path: string,
    public readonly directory: string,
  ) {
    if (directory.trim() === "") {
      throw new TypeError("Static route directory cannot be empty");
    }
  }
}

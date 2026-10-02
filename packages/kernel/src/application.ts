export class BoltApplication {
  #isRunning = false;

  private constructor() {}

  public static create(): BoltApplication {
    return new BoltApplication();
  }

  public get isRunning(): boolean {
    return this.#isRunning;
  }

  public async start(): Promise<this> {
    if (this.#isRunning) {
      return this;
    }

    this.#isRunning = true;

    return this;
  }

  public async stop(): Promise<void> {
    if (!this.#isRunning) {
      return;
    }

    this.#isRunning = false;
  }
}

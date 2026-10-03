import { EnvironmentError } from "./environment-error.ts";

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export class Environment {
  readonly #source: EnvironmentSource;

  private constructor(source: EnvironmentSource) {
    this.#source = source;
  }

  public static create(source: EnvironmentSource = Bun.env): Environment {
    return new Environment(source);
  }

  public get mode(): string {
    return this.string("NODE_ENV", "development");
  }

  public get isDevelopment(): boolean {
    return this.mode === "development";
  }

  public get isProduction(): boolean {
    return this.mode === "production";
  }

  public get isTest(): boolean {
    return this.mode === "test";
  }

  public get(name: string): string | undefined {
    return this.#source[name];
  }

  public has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  public string(name: string, fallback?: string): string {
    return this.read(name, fallback);
  }

  public number(name: string, fallback?: number): number {
    const raw = this.read(name, fallback?.toString());
    const value = Number(raw);

    if (raw.trim() === "" || !Number.isFinite(value)) {
      throw new EnvironmentError(name, "expected a finite number");
    }

    return value;
  }

  public integer(name: string, fallback?: number): number {
    const value = this.number(name, fallback);

    if (!Number.isSafeInteger(value)) {
      throw new EnvironmentError(name, "expected a safe integer");
    }

    return value;
  }

  public boolean(name: string, fallback?: boolean): boolean {
    const raw = this.read(name, fallback?.toString()).trim().toLowerCase();

    if (TRUE_VALUES.has(raw)) {
      return true;
    }

    if (FALSE_VALUES.has(raw)) {
      return false;
    }

    throw new EnvironmentError(
      name,
      "expected true, false, 1, 0, yes, no, on, or off",
    );
  }

  public oneOf<const Values extends readonly string[]>(
    name: string,
    values: Values,
    fallback?: Values[number],
  ): Values[number] {
    const value = this.read(name, fallback);

    if (!values.includes(value)) {
      throw new EnvironmentError(name, `expected one of: ${values.join(", ")}`);
    }

    return value as Values[number];
  }

  private read(name: string, fallback?: string): string {
    const value = this.get(name) ?? fallback;

    if (value === undefined) {
      throw new EnvironmentError(name, "value is required");
    }

    return value;
  }
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export interface CliIO {
  error(message: string): void;
  log(message: string): void;
}

export interface ProcessOptions {
  readonly cwd: string;
}

export type ProcessRunner = (
  command: readonly string[],
  options: ProcessOptions,
) => Promise<number>;

export interface CliDependencies {
  readonly importModule?: (specifier: string) => Promise<unknown>;
  readonly io?: CliIO;
  readonly now?: () => Date;
  readonly runProcess?: ProcessRunner;
}

export interface CliOptions extends CliDependencies {
  readonly argv?: readonly string[];
  readonly cwd?: string;
}

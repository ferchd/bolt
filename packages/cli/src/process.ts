import type { ProcessRunner } from "./types.ts";

export const runProcess: ProcessRunner = async (command, options) => {
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  return await subprocess.exited;
};

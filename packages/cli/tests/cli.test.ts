import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO, type ProcessRunner } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Bolt CLI", () => {
  test("prints help without starting a process", async () => {
    const context = createContext();

    const exitCode = await runCli({
      argv: ["help"],
      io: context.io,
      runProcess: context.runProcess,
    });

    expect(exitCode).toBe(0);
    expect(context.stdout.join("\n")).toContain("make:migration");
    expect(context.processes).toHaveLength(0);
  });

  test("delegates runtime commands to Bun with explicit argument arrays", async () => {
    const context = createContext();

    expect(
      await runCli({
        argv: ["dev", "--entry", "server.ts", "--", "--port", "4000"],
        cwd: "C:/project",
        io: context.io,
        runProcess: context.runProcess,
      }),
    ).toBe(0);
    expect(
      await runCli({
        argv: ["test", "tests/unit", "--", "--watch"],
        cwd: "C:/project",
        io: context.io,
        runProcess: context.runProcess,
      }),
    ).toBe(0);

    expect(context.processes).toEqual([
      {
        command: [
          "bun",
          "--watch",
          "run",
          "server.ts",
          "--port",
          "4000",
        ],
        cwd: "C:/project",
      },
      {
        command: ["bun", "test", "tests/unit", "--watch"],
        cwd: "C:/project",
      },
    ]);
  });

  test("lists dynamic and static routes from the application module", async () => {
    const context = createContext();

    const exitCode = await runCli({
      argv: ["routes"],
      cwd: "C:/project",
      importModule: async () => ({
        router: {
          compile: () => ({
            "/health": {
              GET: { method: "GET", name: "health.show" },
            },
            "/public/*": { directory: "public" },
          }),
        },
      }),
      io: context.io,
    });

    expect(exitCode).toBe(0);
    expect(context.stdout).toEqual([
      "GET /health (health.show)\nSTATIC /public/* -> public",
    ]);
  });

  test("starts and stops the exported database while applying migrations", async () => {
    const context = createContext();
    const calls: string[] = [];
    const startOptions: unknown[] = [];
    let connected = false;

    const exitCode = await runCli({
      argv: ["migrate"],
      cwd: "C:/project",
      importModule: async () => ({
        database: {
          get isConnected() {
            return connected;
          },
          migrate() {
            calls.push("migrate");
            return ["001_users"];
          },
          migrationStatus: () => [],
          start(options?: unknown) {
            connected = true;
            calls.push("start");
            startOptions.push(options);
          },
          stop() {
            connected = false;
            calls.push("stop");
          },
        },
      }),
      io: context.io,
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["start", "migrate", "stop"]);
    expect(startOptions).toEqual([{ migrate: false }]);
    expect(context.stdout).toEqual(["APPLIED 001_users"]);
  });

  test("does not close a database connection owned by the application", async () => {
    const context = createContext();
    let stops = 0;

    const exitCode = await runCli({
      argv: ["migrate:status"],
      cwd: "C:/project",
      importModule: async () => ({
        default: {
          database: {
            isConnected: true,
            migrate: () => [],
            migrationStatus: () => [
              {
                appliedAt: "2026-01-01 00:00:00",
                id: "001_users",
                state: "applied",
              },
            ],
            start() {},
            stop() {
              stops += 1;
            },
          },
        },
      }),
      io: context.io,
    });

    expect(exitCode).toBe(0);
    expect(stops).toBe(0);
    expect(context.stdout[0]).toContain("APPLIED 001_users");
  });

  test("creates controllers and refuses to overwrite them", async () => {
    const root = createTemporaryDirectory();
    const context = createContext();
    const options = {
      argv: ["make:controller", "admin/User"],
      cwd: root,
      io: context.io,
    } as const;

    expect(await runCli(options)).toBe(0);

    const path = join(
      root,
      "src",
      "controllers",
      "admin",
      "user-controller.ts",
    );
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("class UserController");
    expect(await runCli(options)).toBe(1);
    expect(context.stderr.at(-1)).toContain("Refusing to overwrite");
  });

  test("creates deterministic timestamped migrations and rejects traversal", async () => {
    const root = createTemporaryDirectory();
    const context = createContext();

    expect(
      await runCli({
        argv: ["make:migration", "createTasks"],
        cwd: root,
        io: context.io,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      }),
    ).toBe(0);
    expect(
      existsSync(
        join(
          root,
          "database",
          "migrations",
          "20260102030405_create_tasks.ts",
        ),
      ),
    ).toBe(true);

    expect(
      await runCli({
        argv: ["make:migration", "../unsafe"],
        cwd: root,
        io: context.io,
      }),
    ).toBe(1);
  });

  test("creates a minimal application and only installs when requested", async () => {
    const root = createTemporaryDirectory();
    const context = createContext();

    expect(
      await runCli({
        argv: ["new", "my-app", "--no-install"],
        cwd: root,
        io: context.io,
        runProcess: context.runProcess,
      }),
    ).toBe(0);

    const applicationRoot = join(root, "my-app");
    expect(existsSync(join(applicationRoot, "src", "application.ts"))).toBe(
      true,
    );
    expect(
      readFileSync(join(applicationRoot, "src", "application.ts"), "utf8"),
    ).toContain("export const database = Database.create()");
    expect(context.processes).toHaveLength(0);

    expect(
      await runCli({
        argv: ["new", "installed-app"],
        cwd: root,
        io: context.io,
        runProcess: context.runProcess,
      }),
    ).toBe(0);
    expect(context.processes).toEqual([
      { command: ["bun", "install"], cwd: join(root, "installed-app") },
    ]);

    expect(
      await runCli({
        argv: ["new", "my-app", "--no-install"],
        cwd: root,
        io: context.io,
      }),
    ).toBe(1);
  });

  test("returns a usage error for unknown commands", async () => {
    const context = createContext();

    expect(
      await runCli({ argv: ["unknown"], io: context.io }),
    ).toBe(2);
    expect(context.stderr[0]).toContain("Unknown command: unknown");
  });
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bolt-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createContext(): {
  readonly io: CliIO;
  readonly processes: Array<{
    command: readonly string[];
    cwd: string;
  }>;
  readonly runProcess: ProcessRunner;
  readonly stderr: string[];
  readonly stdout: string[];
} {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const processes: Array<{ command: readonly string[]; cwd: string }> = [];

  return {
    io: {
      error: (message) => stderr.push(message),
      log: (message) => stdout.push(message),
    },
    processes,
    runProcess: (command, options) => {
      processes.push({ command, cwd: options.cwd });
      return Promise.resolve(0);
    },
    stderr,
    stdout,
  };
}

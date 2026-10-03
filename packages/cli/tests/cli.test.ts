import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    ).not.toContain("database");
    expect(readFileSync(join(applicationRoot, "src", "application.ts"), "utf8")).not.toContain('router.get');
    const manifest = JSON.parse(readFileSync(join(applicationRoot, "package.json"), "utf8"));
    expect(manifest.dependencies["@bolt/kernel"]).toBe("0.1.0");
    expect(manifest.dependencies["@bolt/database"]).toBeUndefined();
    expect(readFileSync(join(applicationRoot, ".npmrc"), "utf8")).toContain("${BOLT_GITLAB_TOKEN}");
    expect(readFileSync(join(applicationRoot, "bunfig.toml"), "utf8")).toContain('auto = "disable"');
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

  test("waits for async migrations before closing and preserves both failures", async () => {
    const context = createContext();
    const calls: string[] = [];
    const importer = async () => ({
      database: { start() { calls.push("start"); }, stop() { calls.push("stop"); } },
      migrator: { async migrate() { await Promise.resolve(); calls.push("completed"); return ["001"]; }, async migrationStatus() { return []; } },
    });
    expect(await runCli({ argv: ["migrate"], io: context.io, importModule: importer })).toBe(0);
    expect(calls).toEqual(["start", "completed", "stop"]);
    expect(context.stdout).toEqual(["APPLIED 001"]);
    expect(await runCli({ argv: ["migrate"], io: context.io, importModule: async () => ({
      database: { start() {}, stop() { throw new Error("close"); } },
      migrator: { async migrate() { throw new Error("migrate"); }, migrationStatus() { return []; } },
    }) })).toBe(1);
    expect(context.stderr.at(-1)).toContain("Migration failed and connection cleanup also failed");
  });

  test("selects named migration capabilities without closing other connections", async () => {
    const context = createContext();
    const calls: string[] = [];
    expect(await runCli({ argv: ["migrate:status", "--connection", "analytics"], io: context.io, importModule: async () => ({
      connections: { get(name: string) { calls.push(name); return { start() { calls.push("start"); }, stop() { calls.push("stop"); } }; } },
      migrators: { analytics: { migrate() { return []; }, async migrationStatus() { return [{ id: "001", state: "pending" }]; } } },
    }) })).toBe(0);
    expect(calls).toEqual(["analytics", "start", "stop"]);
    expect(context.stdout).toEqual(["PENDING 001"]);
  });

  test("honors developer structure, custom templates, explicit overrides and dry runs", async () => {
    const root = createTemporaryDirectory();
    writeFileSync(join(root, "bolt.config.ts"), `export default { paths: { controllers: "domain/api", entities: "domain/models", migrations: "schema", entry: "boot.ts", tests: "spec" }, templates: { controller: "controller.tpl" } };`);
    writeFileSync(join(root, "controller.tpl"), "export class {{className}} {}\n");
    const context = createContext();
    expect(await runCli({ argv: ["make:controller", "Admin/User"], cwd: root, io: context.io })).toBe(0);
    expect(readFileSync(join(root, "domain/api/admin/user-controller.ts"), "utf8")).toBe("export class UserController {}\n");
    expect(await runCli({ argv: ["make:entity", "User", "--path", "feature/user.ts", "--dry-run"], cwd: root, io: context.io })).toBe(0);
    expect(existsSync(join(root, "feature"))).toBe(false);
    expect(context.stdout.at(-1)).toContain("WOULD CREATE");
    expect(await runCli({ argv: ["make:entity", "User"], cwd: root, io: context.io })).toBe(0);
    expect(readFileSync(join(root, "domain/models/user.ts"), "utf8")).toContain("crypto.randomUUID()");
    expect(await runCli({ argv: ["start"], cwd: root, io: context.io, runProcess: context.runProcess })).toBe(0);
    expect(context.processes.at(-1)?.command).toEqual(["bun", "run", "boot.ts"]);
    expect(await runCli({ argv: ["test"], cwd: root, io: context.io, runProcess: context.runProcess })).toBe(0);
    expect(context.processes.at(-1)?.command).toEqual(["bun", "test", "spec"]);
    expect(await runCli({ argv: ["new", "preview", "--dry-run"], cwd: root, io: context.io, runProcess: context.runProcess })).toBe(0);
    expect(existsSync(join(root, "preview"))).toBe(false);
    expect(await runCli({ argv: ["migrate", "--dry-run"], cwd: root, io: context.io })).toBe(1);
  });

  test("rejects escapes, symbolic links, duplicate paths and broken parents before writing", async () => {
    const root = createTemporaryDirectory();
    const outside = createTemporaryDirectory();
    mkdirSync(join(root, "src"));
    symlinkSync(outside, join(root, "src/controllers"), process.platform === "win32" ? "junction" : "dir");
    const context = createContext();
    expect(await runCli({ argv: ["new", "../outside", "--no-install"], cwd: root, io: context.io })).toBe(1);
    expect(await runCli({ argv: ["make:controller", "User"], cwd: root, io: context.io })).toBe(1);
    expect(existsSync(join(outside, "user-controller.ts"))).toBe(false);
    writeFileSync(join(outside, "entity.tpl"), "export interface {{entityName}} {}\n");
    expect(await runCli({ argv: ["make:entity", "User", "--template", "src/controllers/entity.tpl", "--path", "domain/user.ts"], cwd: root, io: context.io })).toBe(1);
    expect(existsSync(join(root, "domain/user.ts"))).toBe(false);
    expect(await runCli({ argv: ["make:entity", "User", "--path", "../escape.ts"], cwd: root, io: context.io })).toBe(1);
    writeFileSync(join(root, "bolt.config.ts"), 'export default {paths:{entry:"same.ts",application:"same.ts"}}');
    expect(await runCli({ argv: ["new", "colliding", "--no-install"], cwd: root, io: context.io })).toBe(1);
    expect(existsSync(join(root, "colliding"))).toBe(false);
    expect(context.stderr.at(-1)).toContain("collide");
    writeFileSync(join(root, "blocked"), "file");
    expect(await runCli({ argv: ["make:entity", "User", "--path", "blocked/user.ts"], cwd: root, io: context.io })).toBe(1);
  });

  test("copies an explicit skeleton and generates optional native SQL persistence", async () => {
    const root = createTemporaryDirectory();
    const context = createContext();
    mkdirSync(join(root, "skeleton"));
    writeFileSync(join(root, "skeleton/custom.ts"), 'export const name = "{{name}}";');
    expect(await runCli({ argv: ["new", "custom-app", "--template", "skeleton", "--no-install"], cwd: root, io: context.io })).toBe(0);
    expect(readFileSync(join(root, "custom-app/custom.ts"), "utf8")).toContain('"custom-app"');
    expect(existsSync(join(root, "custom-app/src"))).toBe(false);
    expect(await runCli({ argv: ["new", "sql", "--database", "sqlite", "--no-install"], cwd: root, io: context.io })).toBe(0);
    expect(readFileSync(join(root, "sql/src/application.ts"), "utf8")).toContain("new SqlMigrator(database, [])");
    expect(await runCli({ argv: ["new", "invalid", "--database", "oracle", "--no-install"], cwd: root, io: context.io })).toBe(1);
    expect(existsSync(join(root, "invalid"))).toBe(false);
  });

  test("generated SQL project, entity and explicit migration run in an external consumer", async () => {
    const root = createTemporaryDirectory();
    const context = createContext();
    writeFileSync(join(root, "bolt.config.ts"), 'export default { paths: { entry: "bootstrap.ts", application: "app/runtime.ts", entities: "domain/entities", migrations: "schema" } };');
    expect(await runCli({ argv: ["new", "consumer", "--database", "sqlite", "--no-install"], cwd: root, io: context.io })).toBe(0);
    const consumer = join(root, "consumer");
    expect(await runCli({ argv: ["make:entity", "User"], cwd: consumer, io: context.io })).toBe(0);
    expect(await runCli({ argv: ["make:migration", "createUsers"], cwd: consumer, io: context.io, now: () => new Date("2026-01-01T00:00:00Z") })).toBe(0);
    const migrationPath = join(consumer, "schema/20260101000000_create_users.ts");
    writeFileSync(migrationPath, readFileSync(migrationPath, "utf8").replace('// "CREATE TABLE ...",', '"CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)",'));
    const applicationPath = join(consumer, "app/runtime.ts");
    writeFileSync(applicationPath, 'import migration from "../schema/20260101000000_create_users.ts";\n' + readFileSync(applicationPath, "utf8").replace("SqlMigrator(database, [])", "SqlMigrator(database, [migration])"));
    const repository = resolve(import.meta.dir, "../../..").replaceAll("\\", "/");
    const tsconfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8"));
    tsconfig.compilerOptions.paths = { "@bolt/*": [`${repository}/packages/*/src/index.ts`] };
    tsconfig.compilerOptions.typeRoots = [`${repository}/node_modules/@types`];
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(tsconfig));
    writeFileSync(join(consumer, "verify.ts"), `import { database, migrator, application } from "./app/runtime.ts";\nimport { UserEntity } from "./domain/entities/user.ts";\nimport { Repository } from "@bolt/orm";\nimport { runCli } from "@bolt/cli";\nawait database.start();\nawait migrator.migrate();\nconst repository = new Repository(database, UserEntity);\nconst id = crypto.randomUUID();\nawait repository.insert({ id });\nif ((await repository.query().toList())[0]?.id !== id) throw new Error("Generated entity failed");\nawait database.stop();\nif (await runCli({argv:["migrate:status"],cwd:process.cwd()}) !== 0) throw new Error("Generated migrator failed");\nconst server = await application.start();\nif (application.port === 3000) throw new Error("PORT=0 was ignored");\nawait server.stop();\n`);
    // Resolve the framework's own sources explicitly; the root package release smoke verifies tarballs separately.
    const compiler = Bun.spawn([process.execPath, join(repository, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
    const compileOutput = await new Response(compiler.stdout).text() + await new Response(compiler.stderr).text();
    expect(compileOutput).toBe("");
    expect(await compiler.exited).toBe(0);
    const child = Bun.spawn([process.execPath, "run", "verify.ts"], { cwd: consumer, stdout: "pipe", stderr: "pipe", env: { ...process.env, PORT: "0" } });
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    expect(output).not.toContain("error:");
    if (await child.exited !== 0) throw new Error(output);
    expect(output).toContain("APPLIED 20260101000000_create_users");
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

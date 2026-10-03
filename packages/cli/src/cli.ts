import { resolve } from "node:path";
import { defaultPaths, loadProjectConfig } from "./config.ts";

import {
  databaseMigrationStatus,
  listRoutes,
  migrateDatabase,
} from "./application-module.ts";
import { runProcess as defaultRunProcess } from "./process.ts";
import {
  scaffoldApplication,
  scaffoldController,
  scaffoldEntity,
  scaffoldMigration,
} from "./scaffold.ts";
import type { CliOptions } from "./types.ts";

const HELP = `Bolt command line

Usage: bolt <command> [options] [-- arguments]

Commands:
  dev                         Run src/main.ts with Bun watch mode
  start                       Run src/main.ts
  test                        Run tests with Bun's test runner
  routes                      List routes exported by src/application.ts
  migrate                     Apply pending application migrations
  migrate:status              Print application migration status
  make:controller <name>      Create a controller without overwriting files
  make:migration <name>       Create a timestamped migration
  make:entity <name>          Create an ORM entity with assigned UUID keys
  new <directory>             Create a minimal Bolt application
  help                        Show this help

Options:
  --cwd <directory>           Application working directory
  --entry <file>              Main entry point for dev and start
  --app <file>                Application module for routes and migrations
  --no-install                Do not install dependencies after bolt new
  --config <file>             Developer-owned project configuration module
  --path <file>               Override a generator's output file
  --template <file/directory> Use a UTF-8 generator or skeleton template
  --dry-run                   Preview generated paths without writing/installing
  --database <dialect>        Optional sqlite/postgresql/mysql/mariadb skeleton
  --connection <name>         Named connections/migrators export for migrations
  -h, --help                  Show command help

Arguments after -- are forwarded unchanged to Bun.`;

interface ParsedArguments {
  readonly application?: string;
  readonly command?: string;
  readonly cwd: string;
  readonly entry?: string;
  readonly config?: string;
  readonly path?: string;
  readonly template?: string;
  readonly database?: string;
  readonly connection?: string;
  readonly dryRun: boolean;
  readonly forwarded: readonly string[];
  readonly help: boolean;
  readonly install: boolean;
  readonly positionals: readonly string[];
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const io = options.io ?? console;
  const initialDirectory = options.cwd ?? process.cwd();

  try {
    const parsed = parseArguments(options.argv ?? Bun.argv.slice(2), initialDirectory);

    if (!parsed.command || parsed.command === "help" || parsed.help) {
      io.log(HELP);
      return 0;
    }

    const runProcess = options.runProcess ?? defaultRunProcess;
    const importer = options.importModule ?? ((specifier) => import(specifier));
    const config = await loadProjectConfig(parsed.cwd, parsed.config);
    if (parsed.dryRun && !["new", "make:controller", "make:entity", "make:migration"].includes(parsed.command)) throw new TypeError("--dry-run is supported only by scaffold commands");
    if (parsed.database && parsed.command !== "new") throw new TypeError("--database is supported only by new");
    if ((parsed.path || parsed.template) && !["new", "make:controller", "make:entity", "make:migration"].includes(parsed.command)) throw new TypeError("--path and --template are supported only by scaffold commands");
    if (parsed.connection && !["migrate", "migrate:status"].includes(parsed.command)) throw new TypeError("--connection is supported only by migration commands");
    const paths = { ...defaultPaths, ...config.paths };
    const entry = parsed.entry ?? paths.entry;
    const application = resolve(parsed.cwd, parsed.application ?? paths.application);
    const scaffoldOptions = {
      config,
      ...(parsed.path ? { path: parsed.path } : {}),
      ...(parsed.template ? { template: parsed.template } : {}),
      ...(parsed.database ? { database: parsed.database } : {}),
      dryRun: parsed.dryRun,
      ...(parsed.dryRun ? { onPlan: (path: string) => io.log(`WOULD CREATE ${path}`) } : {}),
    };

    switch (parsed.command) {
      case "dev":
        return await runProcess(
          ["bun", "--watch", "run", entry, ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "start":
        return await runProcess(
          ["bun", "run", entry, ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "test":
        return await runProcess(
          ["bun", "test", ...(parsed.positionals.length ? parsed.positionals : config.paths?.tests ? [paths.tests] : []), ...parsed.forwarded],
          { cwd: parsed.cwd },
        );
      case "routes": {
        const routes = await listRoutes(application, importer);
        io.log(routes.length === 0 ? "No routes registered." : routes.join("\n"));
        return 0;
      }
      case "migrate": {
        const migrations = await migrateDatabase(application, importer, parsed.connection);
        io.log(
          migrations.length === 0
            ? "No pending migrations."
            : migrations.map((id) => `APPLIED ${id}`).join("\n"),
        );
        return 0;
      }
      case "migrate:status": {
        const status = await databaseMigrationStatus(application, importer, parsed.connection);
        io.log(status.length === 0 ? "No migrations registered." : status.join("\n"));
        return 0;
      }
      case "make:controller": {
        const name = requirePositional(parsed, "controller name");
        const path = scaffoldController(parsed.cwd, name, scaffoldOptions);
        if (!parsed.dryRun) io.log(`Created ${path}`);
        return 0;
      }
      case "make:entity": {
        const path = scaffoldEntity(parsed.cwd, requirePositional(parsed, "entity name"), scaffoldOptions);
        if (!parsed.dryRun) io.log(`Created ${path}`);
        return 0;
      }
      case "make:migration": {
        const name = requirePositional(parsed, "migration name");
        const path = scaffoldMigration(
          parsed.cwd,
          name,
          (options.now ?? (() => new Date()))(),
          scaffoldOptions,
        );
        if (!parsed.dryRun) io.log(`Created ${path}; import it explicitly into the application SqlMigrator catalog.`);
        return 0;
      }
      case "new": {
        const target = requirePositional(parsed, "target directory");
        if (parsed.path) throw new TypeError("Use the new command's target directory instead of --path");
        const root = scaffoldApplication(parsed.cwd, target, scaffoldOptions);

        if (parsed.install && !parsed.dryRun) {
          const exitCode = await runProcess(["bun", "install"], { cwd: root });

          if (exitCode !== 0) {
            return exitCode;
          }
        }

        if (!parsed.dryRun) io.log(`Created Bolt application at ${root}`);
        return 0;
      }
      default:
        io.error(`Unknown command: ${parsed.command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArguments(
  arguments_: readonly string[],
  initialDirectory: string,
): ParsedArguments {
  let application: string | undefined;
  let cwd = initialDirectory;
  let entry: string | undefined;
  const extra: Record<string, string> = {};
  let dryRun = false;
  let help = false;
  let install = true;
  let forwarding = false;
  const positionals: string[] = [];
  const forwarded: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === undefined) {
      continue;
    }

    if (forwarding) {
      forwarded.push(argument);
      continue;
    }

    if (argument === "--") {
      forwarding = true;
      continue;
    }

    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }

    if (argument === "--no-install") {
      install = false;
      continue;
    }
    if (argument === "--dry-run") { dryRun = true; continue; }

    if (["--cwd", "--entry", "--app", "--config", "--path", "--template", "--database", "--connection"].includes(argument)) {
      const value = arguments_[index + 1];

      if (!value || value.startsWith("--")) {
        throw new TypeError(`${argument} requires a value`);
      }

      index += 1;

      if (argument === "--cwd") {
        cwd = resolve(initialDirectory, value);
      } else if (argument === "--entry") {
        entry = value;
      } else if (argument === "--app") {
        application = value;
      } else {
        extra[argument.slice(2)] = value;
      }

      continue;
    }

    if (argument.startsWith("-")) throw new TypeError(`Unknown option: ${argument}`);
    positionals.push(argument);
  }

  const [command, ...commandPositionals] = positionals;

  return {
    ...(application ? { application } : {}),
    ...(command ? { command } : {}),
    cwd,
    ...(entry ? { entry } : {}),
    ...extra,
    dryRun,
    forwarded,
    help,
    install,
    positionals: commandPositionals,
  };
}

function requirePositional(parsed: ParsedArguments, label: string): string {
  const value = parsed.positionals[0];

  if (!value) {
    throw new TypeError(`${parsed.command ?? "Command"} requires a ${label}`);
  }

  if (parsed.positionals.length > 1) {
    throw new TypeError(`${parsed.command ?? "Command"} accepts only one ${label}`);
  }

  return value;
}
